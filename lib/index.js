/**
 * dsh-exa-web-search — a single minimal Exa `WebSearchProvider` for the
 * `ctx.web` seam.
 *
 * Two transports behind one provider id:
 *
 * - keyed REST, delegated unchanged to the official
 *   `@deepseek-ai/dsh-web-search-exa` `ExaSearchProvider`;
 * - anonymous keyless MCP at `mcp.exa.ai/mcp` (stateless JSON-RPC over SSE,
 *   no `initialize` handshake needed).
 *
 * `mode: 'auto'` (default) uses REST when an API key resolves, MCP otherwise.
 * The keyless channel is a shared, throttled resource: anonymous searches run
 * through a module-wide 2-permit limiter and get exactly one retry after a
 * 429. Rate limits are reported as `WEB_RATE_LIMITED`; the legacy
 * `web_search_exa` tool is used only when the advanced tool is missing,
 * returns nothing usable, or fails non-rate-limitedly — never to dodge
 * throttling, since both tools share the same bucket.
 *
 * No extra tools are registered and nothing is injected into the system
 * prompt.
 *
 * MCP wire details observed against the live endpoint: a `tools` query param
 * is required to expose `web_search_advanced_exa`; the JSON-RPC `id` must be
 * an integer; the response is `text/event-stream` and the result payload sits
 * inside `result.content[0].text`; `enableHighlights: true` is required or
 * results carry only a `text` field and no per-result highlights.
 *
 * @module dsh-exa-web-search
 */
import { launchEnvironmentOf } from "@deepseek-ai/dsh-launch-environment";
import { WebError } from "@deepseek-ai/dsh-web";
import { ExaSearchProvider as OfficialExaSearchProvider } from "@deepseek-ai/dsh-web-search-exa";
import z from "@deepseek-ai/schemastery";

/** Cordis plugin name used by loader diagnostics. */
const name = "exa-web-search";
/** The web seam this provider registers into. */
const inject = ["web"];
/** Stable id this provider registers under. */
const PROVIDER_ID = "exa";

/** Hosted MCP endpoint; `?tools=` is required to expose the advanced tool. */
const DEFAULT_MCP_URL = "https://mcp.exa.ai/mcp?tools=web_search_advanced_exa,web_search_exa";
/** Query spliced in when a configured MCP URL omits `tools`. */
const MCP_TOOLS_QUERY = "tools=web_search_advanced_exa,web_search_exa";
const MCP_TOOL_ADVANCED = "web_search_advanced_exa";
const MCP_TOOL_LEGACY = "web_search_exa";
/** Attribution header on anonymous MCP requests (optional but harmless). */
const MCP_SOURCE = "dsh-exa-web-search";

/** Anonymous MCP requests may run at most this many at once process-wide. */
const ANONYMOUS_MAX_CONCURRENT = 2;
/** One retry after a 429, after this delay. Longer waits buy nothing here. */
const RATE_LIMIT_RETRY_MS = 1000;
/** Per-attempt wall-clock cap for anonymous MCP requests; a stalled endpoint
 * must not park a limiter permit. */
const MCP_REQUEST_TIMEOUT_MS = 30000;
/** Reject anonymous MCP bodies past this size; structured results are ~20KB. */
const MAX_MCP_RESPONSE_BYTES = 262144;
/** Snippet cap for text-derived snippets on the legacy text path. */
const MAX_SNIPPET_CHARS = 500;

/** A rate limit surfaced distinctly so callers can tell throttling from failure. */
var ExaRateLimitError = class extends WebError {
	constructor(message) {
		super(message, "WEB_RATE_LIMITED");
		this.name = "ExaRateLimitError";
	}
};

/** An anonymous MCP body that exceeded {@link MAX_MCP_RESPONSE_BYTES}. */
var ExaResponseTooLargeError = class extends WebError {
	constructor(limit, observedBytes) {
		super(`Exa anonymous MCP response exceeded ${limit} bytes` + (observedBytes === undefined ? "" : ` (received ${observedBytes})`), "WEB_PROVIDER_ERROR");
		this.name = "ExaResponseTooLargeError";
		this.observedBytes = observedBytes;
	}
};

/**
 * Process-wide 2-permit limiter for the anonymous channel. `dsh-tool-web`
 * fans `queries` out in parallel against this provider, and the keyless
 * bucket throttles hard past a couple of concurrent requests, so concurrency
 * control lives here, not at the call site.
 */
const anonymousLimiter = (() => {
	let active = 0;
	const queue = [];
	return async function run(task) {
		if (active >= ANONYMOUS_MAX_CONCURRENT) {
			await new Promise((resolve) => queue.push(resolve));
		}
		active += 1;
		try {
			return await task();
		} finally {
			active -= 1;
			queue.shift()?.();
		}
	};
})();

/** JSON-RPC ids must be integers; a module counter keeps them valid. */
let nextRpcId = 1;

/** True for a fetch/`AbortSignal` abort, surfaced as `WEB_ABORTED`. */
function isAbortError(error) {
	return error instanceof DOMException && error.name === "AbortError";
}

/** True for a positive whole number (cheap local config check). */
function isPositiveInteger(value) {
	return Number.isInteger(value) && value > 0;
}

/** Throw `WEB_ABORTED` when the caller is already aborted. */
function throwIfAborted(signal) {
	if (signal?.aborted === true) throw new WebError("Exa search aborted", "WEB_ABORTED", { cause: signal.reason });
}

/** Abortable sleep used between the single 429 retry. */
function sleep(ms, signal) {
	return new Promise((resolve, reject) => {
		const timer = setTimeout(() => {
			signal?.removeEventListener("abort", onAbort);
			resolve();
		}, ms);
		const onAbort = () => {
			clearTimeout(timer);
			reject(new WebError("Exa search aborted", "WEB_ABORTED", { cause: signal?.reason }));
		};
		signal?.addEventListener("abort", onAbort, { once: true });
	});
}

/**
 * Return the request URL for the advanced tool: when the configured MCP URL
 * carries no `tools` parameter, splice in the query that enables both tools —
 * the advanced tool is not servable otherwise. An existing query is kept.
 */
function endpointFor(baseURL) {
	const queryIndex = baseURL.indexOf("?");
	if (queryIndex >= 0) {
		const tools = new URLSearchParams(baseURL.slice(queryIndex + 1)).get("tools");
		if (tools != null && tools.length > 0) return baseURL;
		return `${baseURL}&${MCP_TOOLS_QUERY}`;
	}
	return `${baseURL}?${MCP_TOOLS_QUERY}`;
}

/**
 * Read a body while refusing to buffer more than `limit` bytes. The cap is
 * enforced while reading — `await response.text()` would materialize the
 * whole body first, so a size check afterwards protects nothing.
 */
async function readBoundedBody(response, limit) {
	const declared = response.headers.get("content-length");
	if (declared !== null) {
		const declaredBytes = Number(declared);
		if (Number.isFinite(declaredBytes) && declaredBytes > limit) {
			await response.body?.cancel().catch(() => {});
			throw new ExaResponseTooLargeError(limit, declaredBytes);
		}
	}
	const body = response.body;
	if (body === null) return await response.text();
	const reader = body.getReader();
	const chunks = [];
	let received = 0;
	try {
		for (;;) {
			const { done, value } = await reader.read();
			if (done) break;
			received += value.byteLength;
			if (received > limit) {
				await reader.cancel().catch(() => {});
				throw new ExaResponseTooLargeError(limit, received);
			}
			chunks.push(value);
		}
	} finally {
		reader.releaseLock();
	}
	const merged = new Uint8Array(received);
	let offset = 0;
	for (const chunk of chunks) {
		merged.set(chunk, offset);
		offset += chunk.byteLength;
	}
	return new TextDecoder().decode(merged);
}

/**
 * Parse an SSE (`text/event-stream`) body into the first successfully parsed
 * event's `data:` payload, falling back to plain JSON. Events are separated by
 * blank lines; each event joins only its own `data:` continuation lines —
 * merging every `data:` line across events would concatenate payloads
 * (including heartbeats) into invalid JSON. Returns `null` when nothing parses.
 */
function parseSsePayload(text) {
	const events = text.split(/\r?\n\r?\n/);
	for (const event of events) {
		const dataLines = event.split(/\r?\n/).filter((line) => line.startsWith("data:")).map((line) => line.slice(5).replace(/^\s/, ""));
		if (dataLines.length === 0) continue;
		try {
			return JSON.parse(dataLines.join("\n"));
		} catch {
			// Not a JSON event (heartbeat or notice); keep looking.
		}
	}
	try {
		return JSON.parse(text);
	} catch {
		return null;
	}
}

/** Collect non-blank `content[].text` blocks from a normalized MCP payload. */
function collectMcpText(payload) {
	const content = payload?.result?.content;
	if (!Array.isArray(content)) return [];
	return content.map((item) => typeof item?.text === "string" ? item.text.replace(/\r\n?/g, "\n").trim() : "").filter((text) => text.length > 0);
}

/**
 * Map one sanitized advanced-tool result to a normalized source, or
 * `undefined` when it has no non-blank highlight — a summary must be a real
 * highlight, never the long-form `text` field.
 */
function mapAdvancedResult(result) {
	if (typeof result !== "object" || result === null) return void 0;
	if (typeof result.url !== "string" || result.url.length === 0) return void 0;
	// Exa highlights run long (often >1k chars); surface them as `summary` so
	// the tool-layer `searchSummaryMaxChars` cap applies — `snippet` is never
	// truncated and is meant for short query-match fragments.
	const summary = (Array.isArray(result.highlights) ? result.highlights : void 0)?.find((highlight) => typeof highlight === "string" && highlight.trim().length > 0)?.trim();
	if (summary === void 0) return void 0;
	return {
		url: result.url,
		...typeof result.title === "string" && result.title.length > 0 ? { title: result.title } : {},
		summary,
		...typeof result.publishedDate === "string" && result.publishedDate.length > 0 ? { publishedAt: result.publishedDate } : {}
	};
}

/**
 * Extract sources from an advanced-tool payload: the first text item is a
 * JSON string in the REST envelope shape (`{ results: [...] }`). Returns
 * `null` when the body is not the expected shape so the caller can degrade to
 * the legacy tool instead of breaking.
 */
function parseAdvancedPayload(payload) {
	const content = payload?.result?.content;
	if (!Array.isArray(content)) return null;
	const text = content.find((item) => typeof item?.text === "string")?.text;
	if (text === void 0) return null;
	let parsed;
	try {
		parsed = JSON.parse(text);
	} catch {
		return null;
	}
	if (typeof parsed !== "object" || parsed === null) return null;
	if (parsed.results === undefined) return [];
	if (!Array.isArray(parsed.results)) return null;
	return parsed.results.map(mapAdvancedResult).filter((source) => source !== void 0);
}

/**
 * Parse one `Title:`-led section of the legacy tool's text output into a
 * partial source. Handles both `Published:` and `Published Date:` spellings.
 */
function parseExaSection(section) {
	const out = {};
	let field = null;
	let textLines = null;
	for (const line of section.split("\n")) {
		// A section may open `Highlights:` then `Text:` (or the reverse). The
		// second marker has to switch the collecting field, otherwise it lands in
		// the previous field and becomes a bogus snippet such as "Text:".
		if (field === "highlights" && /^Text:\s*$/.test(line)) {
			field = "text";
			textLines = [];
			continue;
		}
		if (field === "text" && /^Highlights:\s*$/.test(line)) {
			field = "highlights";
			continue;
		}
		// Header fields (`Title:`/`URL:`/`Published:`/`Author:`) are only
		// meaningful while `field === null`; once `Text:` or `Highlights:` opens,
		// a page-body line like `URL: http://x` must not rewrite the source url.
		if (field === null) {
			const title = line.match(/^Title:\s*(.*)$/);
			const url = line.match(/^URL:\s*(.*)$/);
			const published = line.match(/^Published(?: Date)?:\s*(.*)$/);
			const author = line.match(/^Author:\s*(.*)$/);
			if (title) {
				out.title = title[1].trim();
			} else if (url) {
				out.url = url[1].trim();
			} else if (published) {
				out.publishedAt = published[1].trim();
			} else if (/^Highlights:\s*$/.test(line)) {
				field = "highlights";
			} else if (/^Text:\s*$/.test(line)) {
				field = "text";
				textLines = [];
			}
			continue;
		}
		if (field === "highlights") {
			const trimmed = line.trim();
			if (trimmed.length > 0) {
				out.highlights ??= [];
				out.highlights.push(trimmed.replace(/^[-•]\s*/, ""));
			}
		} else if (field === "text" && textLines !== null) {
			textLines.push(line);
		}
	}
	if (textLines !== null) out.text = textLines.join("\n").trim();
	if (out.publishedAt === "N/A") delete out.publishedAt;
	return out;
}

/** Split joined MCP text into per-result sections, each starting with `Title:`. */
function splitExaSections(joined) {
	return joined.split(/\n{2,}(?=Title:\s*)/).map((section) => section.trim()).filter((section) => section.length > 0 && section.startsWith("Title:"));
}

/** Map parsed legacy-text sections to normalized sources (summary-less dropped). */
function mapMcpSections(sections) {
	const sources = [];
	for (const section of sections) {
		const parsed = parseExaSection(section);
		if (!parsed.url || parsed.url.length === 0) continue;
		const summary = parsed.highlights?.find((item) => item.trim().length > 0) ?? (parsed.text ? parsed.text.slice(0, MAX_SNIPPET_CHARS) : void 0);
		if (summary === void 0) continue;
		sources.push({
			url: parsed.url,
			...parsed.title != null && parsed.title.length > 0 ? { title: parsed.title } : {},
			summary,
			...parsed.publishedAt != null && parsed.publishedAt.length > 0 ? { publishedAt: parsed.publishedAt } : {}
		});
	}
	return sources;
}

/**
 * True when a keyed-path failure looks like a rejected credential (HTTP 401
 * or Exa's `INVALID_API_KEY` body). The official provider wraps the status in
 * its message, so matching the message is the only available signal — the
 * match is deliberately narrow. `code` rather than `instanceof WebError` is
 * the portable contract: installed copies may carry a different WebError
 * class object.
 */
function isCredentialError(error) {
	if (error == null || error.code !== "WEB_PROVIDER_ERROR" || typeof error.message !== "string") return false;
	return /401|unauthor|forbidden|invalid.{0,16}key/i.test(error.message);
}

/**
 * One anonymous MCP `tools/call`, retried exactly once after a 429.
 * The keyless bucket recovers in about a second for a single request, so the
 * retry is short; a second 429 is reported as `WEB_RATE_LIMITED`.
 *
 * @param tool - `web_search_advanced_exa` or `web_search_exa`.
 * @returns the normalized sources from that tool call.
 */
async function callMcpTool(request, options, tool, signal) {
	const isAdvanced = tool === MCP_TOOL_ADVANCED;
	const args = { query: request.query };
	const numResults = request.maxResults ?? options.numResults;
	if (numResults !== undefined) args.numResults = numResults;
	if (isAdvanced) {
		args.enableHighlights = true;
		args.highlightsNumSentences = options.highlightsPerResult;
	}
	for (let attempt = 0; ; attempt += 1) {
		throwIfAborted(signal);
		if (attempt > 0) await sleep(RATE_LIMIT_RETRY_MS, signal);
		let response;
		const attemptSignal = AbortSignal.any([...signal !== undefined ? [signal] : [], AbortSignal.timeout(MCP_REQUEST_TIMEOUT_MS)]);
		try {
			response = await fetch(endpointFor(options.mcpURL), {
				method: "POST",
				redirect: "error",
				headers: {
					"content-type": "application/json",
					"accept": "application/json, text/event-stream",
					"x-exa-source": MCP_SOURCE
				},
				body: JSON.stringify({
					jsonrpc: "2.0",
					id: nextRpcId++,
					method: "tools/call",
					params: { name: tool, arguments: args }
				}),
				signal: attemptSignal
			});
		} catch (error) {
			if (signal?.aborted === true || isAbortError(error)) {
				throw new WebError("Exa anonymous search aborted", "WEB_ABORTED", { cause: signal?.reason ?? error });
			}
			throw new WebError(`Exa anonymous search request failed: ${String(error)}`, "WEB_PROVIDER_ERROR", { cause: error });
		}
		if (!response.ok) {
			if (response.status === 429) {
				if (attempt === 0) continue; // one retry, then surface the limit
				throw new ExaRateLimitError("Exa anonymous MCP rate limit (HTTP 429). The keyless channel is shared and throttled; configure EXA_API_KEY to use the keyed REST path.");
			}
			throw new WebError(`Exa anonymous MCP error (HTTP ${response.status})`, "WEB_PROVIDER_ERROR");
		}
		let text;
		try {
			text = await readBoundedBody(response, MAX_MCP_RESPONSE_BYTES);
		} catch (error) {
			if (signal?.aborted === true || isAbortError(error)) {
				throw new WebError("Exa anonymous search aborted", "WEB_ABORTED", { cause: signal?.reason ?? error });
			}
			throw error;
		}
		const payload = parseSsePayload(text);
		if (payload === null) {
			throw new WebError("Exa anonymous MCP returned an unprocessable response body", "WEB_PROVIDER_ERROR");
		}
		if (payload.error != null) {
			throw new WebError(`Exa MCP error: ${String(payload.error.message ?? JSON.stringify(payload.error))}`, "WEB_PROVIDER_ERROR");
		}
		if (payload.result?.isError === true) {
			const detail = collectMcpText(payload).join("\n").trim();
			throw new WebError(`Exa MCP tool error${detail.length > 0 ? `: ${detail}` : ""}`, "WEB_PROVIDER_ERROR");
		}
		if (isAdvanced) {
			const structured = parseAdvancedPayload(payload);
			if (structured === null) {
				throw new WebError("Exa advanced MCP returned an unrecognized payload", "WEB_PROVIDER_ERROR");
			}
			return structured;
		}
		return mapMcpSections(splitExaSections(collectMcpText(payload).join("\n\n")));
	}
}

/**
 * Anonymous search: advanced tool first, legacy text tool only when the
 * advanced path cannot produce sources — never to dodge a rate limit, since
 * both tools draw from the same bucket.
 */
async function anonymousSearch(request, options, signal) {
	return anonymousLimiter(async () => {
		let sources;
		let triedLegacy = false;
		try {
			sources = await callMcpTool(request, options, MCP_TOOL_ADVANCED, signal);
		} catch (error) {
			if (error instanceof ExaRateLimitError) throw error;
			if (error?.code === "WEB_ABORTED") throw error;
			// Unknown tool, non-429 HTTP error, or unparseable payload -> legacy.
			triedLegacy = true;
			sources = await callMcpTool(request, options, MCP_TOOL_LEGACY, signal);
		}
		if (sources.length === 0 && !triedLegacy) {
			try {
				sources = await callMcpTool(request, options, MCP_TOOL_LEGACY, signal);
			} catch (error) {
				if (error instanceof ExaRateLimitError) throw error;
				if (error?.code === "WEB_ABORTED") throw error;
				// Legacy fallback failing after an empty advanced result still
				// yields an empty result rather than a hard error.
				return { sources: [], truncated: false };
			}
		}
		return { sources, truncated: false };
	});
}

/** The dual-transport Exa-backed `WebSearchProvider`. */
var ExaWebSearchProvider = class {
	options;
	keyed;
	id = PROVIDER_ID;
	/**
	 * Display name for the provider picker. Hosts before 0.2.2-rc.3 do not read
	 * this field and fall back to `id`, so it is safe to declare unconditionally.
	 */
	title = "Exa";
	/**
	 * What the picker shows under this provider once selected. Hosts before
	 * 0.2.2-rc.3 ignore it; the English entry is required, others fall back.
	 */
	description = {
		en: "Uses the official Exa API when a key is configured, the free shared MCP channel otherwise. The free channel runs at most two searches at a time and may be rate-limited.",
		zh: "有 Key 时走 Exa 官方 API，没有 Key 时走免费的公共通道。公共通道同时最多跑两个查询，量大时可能被限流。"
	};
	constructor(options, keyed) {
		this.options = options;
		this.keyed = keyed;
	}
	available() {
		// Keyed availability follows the official provider's own check; it is
		// sufficient on its own under `keyed`/`auto`. Anonymous needs a parseable
		// MCP URL and is an additional fallback under `auto` only.
		if (this.options.mode === "keyed") return this.keyed.available();
		if (this.options.mode === "auto" && this.keyed.available()) return true;
		return URL.canParse(this.options.mcpURL) && isPositiveInteger(this.options.highlightsPerResult);
	}
	async search(request, signal) {
		const useKeyed = this.options.mode === "keyed" || (this.options.mode === "auto" && this.keyed.available());
		if (useKeyed) {
			try {
				return await this.keyed.search(request, signal);
			} catch (error) {
				if (signal?.aborted === true) {
					throw new WebError("Exa search aborted", "WEB_ABORTED", { cause: signal.reason });
				}
				// A rejected key must not silently degrade to the anonymous
				// channel — that would look like the key still works.
				if (isCredentialError(error)) {
					throw new WebError("Exa API key was rejected; fix EXA_API_KEY or the configured apiKey", "INVALID_CREDENTIAL", { cause: error });
				}
				throw error;
			}
		}
		return anonymousSearch(request, this.options, signal);
	}
};

/**
 * Resolve the API key: literal config first, then the environment variable
 * snapshot. `undefined` selects the anonymous path.
 */
/**
 * Unwrap a possibly volatile field: the Loader delivers `.volatile()` schema
 * fields as stable `{ get() }` references it can update in place; plain fields
 * stay plain values.
 */
function readVolatile(value) {
	return value !== null && typeof value === "object" && typeof value.get === "function" ? value.get() : value;
}

function resolveApiKey(config, environment) {
	const configured = readVolatile(config.apiKey);
	if (typeof configured === "string" && configured.length > 0) return configured;
	const fromEnvironment = environment?.get(readVolatile(config.apiKeyEnv) ?? "EXA_API_KEY")?.value;
	if (fromEnvironment != null && fromEnvironment.length > 0) return fromEnvironment;
	return void 0;
}

const Config = z.object({
	/**
	 * Transport selection: `auto` uses keyed REST when a key resolves and
	 * anonymous MCP otherwise; `anonymous` forces keyless; `keyed` requires a
	 * key and never falls back.
	 */
	mode: z.union(["auto", "anonymous", "keyed"]),
	/**
	 * Literal Exa API key; an empty/missing value enables the anonymous path.
	 * `volatile` so the Settings describe mirror publishes this namespace and a
	 * saved key reloads the provider without an app restart.
	 */
	apiKey: z.string().role("secret").volatile(),
	/** Environment variable consulted when no literal `apiKey` is configured. */
	apiKeyEnv: z.string(),
	/** Exa API base URL for the keyed REST path; `/search` is appended. */
	baseURL: z.string(),
	/** Exa hosted MCP endpoint for the anonymous path. */
	mcpURL: z.string(),
	/** REST retrieval mode for the keyed path (Exa `type`): auto, keyword, neural, lite, deep-lite, deep, deep-reasoning. */
	searchType: z.union(["auto", "keyword", "neural", "lite", "deep-lite", "deep", "deep-reasoning"]),
});

/** Build the dual-transport provider around a keyed REST provider for the resolved key. */
function mountProvider(ctx, config, environment) {
	const options = {
		mode: config.mode ?? "auto",
		mcpURL: config.mcpURL ?? DEFAULT_MCP_URL,
		highlightsPerResult: 1,
	};
	const keyed = new OfficialExaSearchProvider({
		apiKey: resolveApiKey(config, environment) ?? "",
		baseURL: config.baseURL ?? "https://api.exa.ai",
		searchType: config.searchType ?? "auto",
		highlightsPerResult: 1,
	});
	const provider = new ExaWebSearchProvider(options, keyed);
	try {
		return ctx.web.registerSearchProvider(provider);
	} catch (error) {
		// Another plugin already owns the `exa` id (e.g. the official Exa provider).
		// Keep this plugin alive and leave that provider in place instead of failing
		// activation; the user only has to disable one of the two.
		if (error && error.code === "WEB_DUPLICATE_PROVIDER") {
			ctx.logger?.warn?.("dsh-exa-web-search: search provider \"exa\" is already registered by another plugin; keeping it. Disable the other Exa plugin to use this one's dual-channel search.");
			return () => {};
		}
		throw error;
	}
}

/** Register the provider and rebuild it when a volatile apiKey edit lands. */
function apply(ctx, config) {
	const environment = launchEnvironmentOf(ctx);
	ctx.effect(() => {
		let dispose = mountProvider(ctx, config, environment);
		const off = ctx.on("loader/volatile-update", () => {
			dispose();
			dispose = mountProvider(ctx, config, environment);
		});
		return () => {
			off();
			dispose();
		};
	}, "exa-web-search: provider");
}

export { Config, ExaRateLimitError, ExaResponseTooLargeError, ExaWebSearchProvider, PROVIDER_ID, apply, inject, name };
