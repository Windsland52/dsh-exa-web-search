/**
 * Adversarial runtime tests for dsh-exa-web-search (lib/index.js).
 * Run: npm test
 */
import {
  Config,
  ExaRateLimitError,
  ExaResponseTooLargeError,
  ExaWebSearchProvider,
  PROVIDER_ID,
  apply,
  inject,
  name,
} from "../lib/index.js";

const MCP_URL = "https://mcp.exa.ai/mcp";
const DEFAULT_MCP_URL =
  "https://mcp.exa.ai/mcp?tools=web_search_advanced_exa,web_search_exa";
const REAL_FETCH = globalThis.fetch;

/* ------------------------------------------------------------------ */
/* tiny assertion + reporting harness                                  */
/* ------------------------------------------------------------------ */
const results = [];

function assert(condition, message) {
  if (!condition) throw new Error(message);
}
function assertEqual(actual, expected, label) {
  if (!Object.is(actual, expected)) {
    throw new Error(
      `${label}: expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`,
    );
  }
}
function assertDeepEqual(actual, expected, label) {
  const a = JSON.stringify(actual);
  const b = JSON.stringify(expected);
  if (a !== b) throw new Error(`${label}: expected ${b}, got ${a}`);
}

async function test(testName, fn, options = {}) {
  const start = performance.now();
  try {
    await fn();
    results.push({ name: testName, status: "PASS", ms: performance.now() - start });
    console.log(`PASS  ${testName}`);
  } catch (error) {
    const status = options.knownBug ? "BUG" : "FAIL";
    results.push({
      name: testName,
      status,
      detail: error instanceof Error ? error.message : String(error),
      ms: performance.now() - start,
    });
    console.log(`${status}  ${testName}`);
    console.log(`      ${error instanceof Error ? error.message : String(error)}`);
  }
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function capture(promise) {
  try {
    return { value: await promise };
  } catch (error) {
    return { error };
  }
}

/* ------------------------------------------------------------------ */
/* fetch / response helpers                                            */
/* ------------------------------------------------------------------ */
function installFetch(mock) {
  globalThis.fetch = mock;
}
function restoreFetch() {
  globalThis.fetch = REAL_FETCH;
}

function stubKeyed({ available = true, search } = {}) {
  return {
    available() {
      return typeof available === "function" ? available() : available;
    },
    async search(request, signal) {
      if (search) return await search(request, signal);
      return { sources: [], truncated: false };
    },
  };
}

function makeProvider(overrides = {}, keyed = stubKeyed({ available: false })) {
  return new ExaWebSearchProvider(
    {
      mode: "anonymous",
      mcpURL: MCP_URL,
      highlightsPerResult: 1,
      numResults: undefined,
      ...overrides,
    },
    keyed,
  );
}

function sseResponse(payload, status = 200) {
  const text = `event: message\ndata: ${JSON.stringify(payload)}\n\n`;
  return new Response(text, {
    status,
    headers: { "content-type": "text/event-stream" },
  });
}

function advancedEnvelope(results) {
  return {
    result: {
      content: [{ type: "text", text: JSON.stringify({ results }) }],
    },
  };
}

function legacyEnvelope(text) {
  return { result: { content: [{ type: "text", text }] } };
}

/** Record every fetch call (url + parsed JSON-RPC body + init). */
function recorder(handler) {
  const calls = [];
  const fetchMock = async (url, init = {}) => {
    let body;
    try {
      body = typeof init.body === "string" ? JSON.parse(init.body) : undefined;
    } catch {
      body = init.body;
    }
    const call = { url: String(url), init, body, at: performance.now() };
    calls.push(call);
    return await handler(call, calls.length - 1);
  };
  fetchMock.calls = calls;
  return fetchMock;
}

/**
 * A body object with an explicit reader. Counts actual `read()` calls rather
 * than ReadableStream prefetch, so "bounded reading" is measured exactly.
 */
function fakeBody(stats, { chunkSize = 65536, chunkCount = 100 } = {}) {
  return {
    getReader() {
      return {
        async read() {
          if (stats.reads >= chunkCount) return { done: true, value: undefined };
          stats.reads += 1;
          stats.bytes = (stats.bytes ?? 0) + chunkSize;
          return { done: false, value: new Uint8Array(chunkSize).fill(65) };
        },
        async cancel() {
          stats.cancelled = true;
        },
        releaseLock() {},
      };
    },
    async cancel() {
      stats.cancelled = true;
    },
  };
}

function streamResponse(stats, options = {}) {
  return {
    ok: true,
    status: 200,
    headers: { get: () => null },
    body: fakeBody(stats, options),
  };
}

function declaredLengthResponse(stats, declaredBytes) {
  return {
    ok: true,
    status: 200,
    headers: { get: (header) => (header === "content-length" ? String(declaredBytes) : null) },
    body: fakeBody(stats),
  };
}

/* ------------------------------------------------------------------ */
/* 1. anonymous advanced success                                       */
/* ------------------------------------------------------------------ */
await test("1. anonymous advanced success: SSE envelope -> normalized sources", async () => {
  let seen = null;
  const fetchMock = recorder(async (call) => {
    seen = call;
    return sseResponse(
      advancedEnvelope([
        {
          url: "https://alpha.example/article",
          title: "Alpha Article",
          publishedDate: "2025-01-02T00:00:00.000Z",
          highlights: ["   ", "A solid highlight sentence."],
          text: "long-form body that must never become the summary",
        },
        {
          url: "https://beta.example/post",
          title: "Beta Post",
          highlights: ["Second highlight"],
        },
        {
          url: "https://gamma.example/no-highlight",
          title: "No Highlight",
          highlights: ["   "],
          text: "fallback text must not be used on advanced path",
        },
        { title: "No URL", highlights: ["orphan"] },
      ]),
    );
  });
  installFetch(fetchMock);
  try {
    const provider = makeProvider({ highlightsPerResult: 2, numResults: 10 });
    const result = await provider.search({ query: "quantum computing", maxResults: 5 });

    assertEqual(fetchMock.calls.length, 1, "fetch call count");
    assert(seen.url.includes("tools=web_search_advanced_exa"), `advanced URL carries tools query: ${seen.url}`);
    assertEqual(seen.body.method, "tools/call", "jsonrpc method");
    assert(Number.isInteger(seen.body.id), "jsonrpc id is an integer");
    assertEqual(seen.body.params.name, "web_search_advanced_exa", "advanced tool name");
    assertEqual(seen.body.params.arguments.query, "quantum computing", "query arg");
    assertEqual(seen.body.params.arguments.enableHighlights, true, "enableHighlights arg");
    assertEqual(seen.body.params.arguments.highlightsNumSentences, 2, "highlightsPerResult arg");
    assertEqual(seen.body.params.arguments.numResults, 5, "maxResults overrides default numResults");

    assertEqual(result.truncated, false, "truncated");
    assertEqual(result.sources.length, 2, "sources count (highlight-less dropped)");
    assertDeepEqual(
      result.sources[0],
      {
        url: "https://alpha.example/article",
        title: "Alpha Article",
        summary: "A solid highlight sentence.",
        publishedAt: "2025-01-02T00:00:00.000Z",
      },
      "first source mapping",
    );
    assertDeepEqual(
      result.sources[1],
      { url: "https://beta.example/post", title: "Beta Post", summary: "Second highlight" },
      "second source mapping",
    );
  } finally {
    restoreFetch();
  }
});

/* ------------------------------------------------------------------ */
/* 2. legacy fallback                                                  */
/* ------------------------------------------------------------------ */
const LEGACY_TEXT = [
  "Title: Alpha",
  "URL: https://alpha.example/page",
  "Published: 2024-06-01",
  "Highlights:",
  "- Alpha highlight one",
  "- Alpha highlight two",
  "",
  "Title: Beta",
  "URL: https://beta.example/page",
  "Published Date: N/A",
  "Text:",
  "Beta body text that is used only when no highlight exists.",
  "",
  "Title: Gamma",
  "URL: https://gamma.example/page",
  "Highlights:",
  "Text:",
].join("\n");

await test("2a. legacy fallback on malformed advanced payload", async () => {
  const fetchMock = recorder(async (call, index) => {
    if (index === 0) {
      return sseResponse({
        result: { content: [{ type: "text", text: "this is not json" }] },
      });
    }
    assertEqual(call.body.params.name, "web_search_exa", "second call uses legacy tool");
    return sseResponse(legacyEnvelope(LEGACY_TEXT));
  });
  installFetch(fetchMock);
  try {
    const provider = makeProvider();
    const result = await provider.search({ query: "fallback query" });
    assertEqual(fetchMock.calls.length, 2, "fetch call count");
    assertEqual(fetchMock.calls[1].url, DEFAULT_MCP_URL, "legacy fallback keeps the tools-scoped endpoint");
    assertEqual(result.truncated, false, "truncated");
    assertEqual(result.sources.length, 2, "snippet-less Gamma section dropped");
    assertDeepEqual(
      result.sources[0],
      {
        url: "https://alpha.example/page",
        title: "Alpha",
        summary: "Alpha highlight one",
        publishedAt: "2024-06-01",
      },
      "legacy section mapping",
    );
    assertEqual(result.sources[1].title, "Beta", "Beta title");
    assertEqual(result.sources[1].summary, "Beta body text that is used only when no highlight exists.", "Text-derived summary");
    assert(!("publishedAt" in result.sources[1]), "Published Date: N/A is dropped");
  } finally {
    restoreFetch();
  }
});

await test("2b. legacy fallback on empty advanced results", async () => {
  const fetchMock = recorder(async (call, index) => {
    if (index === 0) return sseResponse(advancedEnvelope([]));
    assertEqual(call.body.params.name, "web_search_exa", "fallback tool name");
    return sseResponse(legacyEnvelope("Title: Only\nURL: https://only.example\nHighlights:\n- only highlight"));
  });
  installFetch(fetchMock);
  try {
    const result = await makeProvider().search({ query: "empty advanced" });
    assertEqual(fetchMock.calls.length, 2, "fetch call count");
    assertEqual(result.sources.length, 1, "legacy source returned");
    assertDeepEqual(result.sources[0], {
      url: "https://only.example",
      title: "Only",
      summary: "only highlight",
    }, "legacy mapped source");
  } finally {
    restoreFetch();
  }
});

/* ------------------------------------------------------------------ */
/* 3. 429 retry                                                        */
/* ------------------------------------------------------------------ */
await test("3a. 429 then 200 -> exactly 2 calls after ~1s", async () => {
  const fetchMock = recorder(async (call, index) => {
    if (index === 0) return new Response("rate limited", { status: 429 });
    return sseResponse(advancedEnvelope([{ url: "https://ok.example", highlights: ["ok"] }]));
  });
  installFetch(fetchMock);
  try {
    const started = performance.now();
    const result = await makeProvider().search({ query: "retry once" });
    const elapsed = performance.now() - started;
    assertEqual(fetchMock.calls.length, 2, "fetch call count");
    assert(elapsed >= 900, `retry waited ~1s (elapsed ${elapsed.toFixed(0)}ms)`);
    assert(elapsed < 3000, `retry did not wait absurdly long (elapsed ${elapsed.toFixed(0)}ms)`);
    assertEqual(result.sources.length, 1, "second response mapped");
  } finally {
    restoreFetch();
  }
});

await test("3b. 429 twice -> ExaRateLimitError WEB_RATE_LIMITED", async () => {
  const fetchMock = recorder(async () => new Response("rate limited", { status: 429 }));
  installFetch(fetchMock);
  try {
    const { error } = await capture(makeProvider().search({ query: "retry twice" }));
    assert(error instanceof ExaRateLimitError, `error is ExaRateLimitError, got ${error?.constructor?.name}: ${error?.message}`);
    assertEqual(error.code, "WEB_RATE_LIMITED", "error code");
    assertEqual(fetchMock.calls.length, 2, "fetch call count (one retry only)");
  } finally {
    restoreFetch();
  }
});

/* ------------------------------------------------------------------ */
/* 4. response size cap                                                */
/* ------------------------------------------------------------------ */
await test("4a. oversized advanced body -> bounded read then legacy fallback", async () => {
  const advancedStats = { reads: 0, cancelled: false };
  const fetchMock = recorder(async (call, index) => {
    if (index === 0) return streamResponse(advancedStats);
    return sseResponse(legacyEnvelope("Title: Small\nURL: https://small.example\nHighlights:\n- small highlight"));
  });
  installFetch(fetchMock);
  try {
    const result = await makeProvider().search({ query: "oversized advanced" });
    assertEqual(fetchMock.calls.length, 2, "fetch call count (advanced + legacy)");
    assertEqual(result.sources[0]?.url, "https://small.example", "legacy result survives oversized advanced");
    assert(advancedStats.cancelled === true, "oversized advanced body was cancelled");
    assert(advancedStats.reads <= 6, `bounded reading: read ${advancedStats.reads} chunks (cap is 5 x 64KB)`);
  } finally {
    restoreFetch();
  }
});

await test("4b. oversized body on both tools -> ExaResponseTooLargeError", async () => {
  const statsA = { reads: 0, cancelled: false };
  const statsB = { reads: 0, cancelled: false };
  const fetchMock = recorder(async (call, index) =>
    index === 0 ? streamResponse(statsA) : streamResponse(statsB),
  );
  installFetch(fetchMock);
  try {
    const { error } = await capture(makeProvider().search({ query: "too large" }));
    assert(error instanceof ExaResponseTooLargeError, `error is ExaResponseTooLargeError, got ${error?.constructor?.name}: ${error?.message}`);
    assertEqual(error.code, "WEB_PROVIDER_ERROR", "error code");
    assert(error.observedBytes > 262144, `observedBytes ${error.observedBytes} > 262144`);
    assert(statsA.reads <= 6 && statsB.reads <= 6, `bounded reads: advanced=${statsA.reads} chunks, legacy=${statsB.reads} chunks`);
    assert(statsA.cancelled && statsB.cancelled, "both oversized bodies cancelled");
  } finally {
    restoreFetch();
  }
});

await test("4c. declared content-length over cap rejects before reading body", async () => {
  const statsA = { reads: 0, cancelled: false };
  const statsB = { reads: 0, cancelled: false };
  const fetchMock = recorder(async (call, index) =>
    declaredLengthResponse(index === 0 ? statsA : statsB, 300000),
  );
  installFetch(fetchMock);
  try {
    const { error } = await capture(makeProvider().search({ query: "declared too large" }));
    assert(error instanceof ExaResponseTooLargeError, `error is ExaResponseTooLargeError, got ${error?.constructor?.name}`);
    assertEqual(error.observedBytes, 300000, "observedBytes from declaration");
    assertEqual(statsA.reads, 0, "advanced stream not read at all");
    assertEqual(statsB.reads, 0, "legacy stream not read at all");
    assert(statsA.cancelled === true, "advanced body cancelled before reading");
  } finally {
    restoreFetch();
  }
});

/* ------------------------------------------------------------------ */
/* 5. abort behavior                                                   */
/* ------------------------------------------------------------------ */
await test("5a. pre-aborted signal -> WEB_ABORTED with no fetch", async () => {
  let fetchCount = 0;
  installFetch(async () => {
    fetchCount += 1;
    return sseResponse(advancedEnvelope([]));
  });
  try {
    const controller = new AbortController();
    controller.abort("stop-before-start");
    const { error } = await capture(makeProvider().search({ query: "aborted" }, controller.signal));
    assert(error != null, `expected throw, got ${JSON.stringify(error)}`);
    assertEqual(error.code, "WEB_ABORTED", "error code");
    assertEqual(fetchCount, 0, "fetch must not run for pre-aborted signal");
  } finally {
    restoreFetch();
  }
});

await test("5b. abort during fetch -> WEB_ABORTED (not swallowed)", async () => {
  let fetchCount = 0;
  installFetch(async (url, init) => {
    fetchCount += 1;
    return await new Promise((resolve, reject) => {
      const signal = init.signal;
      if (signal.aborted) {
        reject(new DOMException("Aborted", "AbortError"));
        return;
      }
      signal.addEventListener("abort", () => reject(new DOMException("Aborted", "AbortError")), { once: true });
    });
  });
  try {
    const controller = new AbortController();
    const searchPromise = makeProvider().search({ query: "abort mid fetch" }, controller.signal);
    await delay(30);
    controller.abort("mid-flight");
    const { error } = await capture(searchPromise);
    assert(error != null, `expected throw, got ${JSON.stringify(error)}`);
    assertEqual(error.code, "WEB_ABORTED", "error code");
    assertEqual(fetchCount, 1, "one fetch attempted");
  } finally {
    restoreFetch();
  }
});

await test(
  "5c. abort during legacy fallback after empty advanced -> WEB_ABORTED",
  async () => {
    let legacyStarted = false;
    installFetch(async (url, init) => {
      const body = JSON.parse(init.body);
      if (body.params.name === "web_search_advanced_exa") {
        return sseResponse(advancedEnvelope([]));
      }
      legacyStarted = true;
      return await new Promise((resolve, reject) => {
        const signal = init.signal;
        if (signal.aborted) {
          reject(new DOMException("Aborted", "AbortError"));
          return;
        }
        signal.addEventListener("abort", () => reject(new DOMException("Aborted", "AbortError")), { once: true });
      });
    });
    try {
      const controller = new AbortController();
      const searchPromise = makeProvider().search({ query: "abort legacy" }, controller.signal);
      for (let i = 0; i < 200 && !legacyStarted; i += 1) await delay(5);
      assert(legacyStarted, "legacy fallback fetch started");
      controller.abort("abort-during-legacy");
      const outcome = await capture(searchPromise);
      assert(
        outcome.error != null,
        `expected WEB_ABORTED, but search resolved with ${JSON.stringify(outcome.value)}`,
      );
      assertEqual(outcome.error.code, "WEB_ABORTED", "error code");
    } finally {
      restoreFetch();
    }
  },
  { knownBug: true },
);

/* ------------------------------------------------------------------ */
/* 6. limiter                                                          */
/* ------------------------------------------------------------------ */
await test("6. limiter caps 5 concurrent anonymous searches at 2", async () => {
  let inFlight = 0;
  let maxInFlight = 0;
  const fetchMock = recorder(async (call) => {
    inFlight += 1;
    maxInFlight = Math.max(maxInFlight, inFlight);
    await delay(40);
    inFlight -= 1;
    const query = call.body.params.arguments.query;
    return sseResponse(advancedEnvelope([{ url: `https://example.test/${query}`, highlights: ["h"] }]));
  });
  installFetch(fetchMock);
  try {
    const provider = makeProvider();
    const settled = await Promise.all(
      Array.from({ length: 5 }, (_, index) => provider.search({ query: `q${index}` })),
    );
    assertEqual(settled.length, 5, "all five searches settled");
    assert(settled.every((r) => Array.isArray(r.sources) && r.sources.length === 1), "each search has a result");
    assert(maxInFlight <= 2, `max concurrent fetch was ${maxInFlight}, expected <= 2`);
    assert(maxInFlight >= 1, "at least one fetch ran");
  } finally {
    restoreFetch();
  }
});

/* ------------------------------------------------------------------ */
/* 7. multi-query fan-out                                              */
/* ------------------------------------------------------------------ */
await test("7. 4-query fan-out serializes without deadlock", async () => {
  let inFlight = 0;
  let maxInFlight = 0;
  const fetchMock = recorder(async (call) => {
    inFlight += 1;
    maxInFlight = Math.max(maxInFlight, inFlight);
    await delay(25);
    inFlight -= 1;
    const query = call.body.params.arguments.query;
    return sseResponse(advancedEnvelope([{ url: `https://fanout.test/${encodeURIComponent(query)}`, highlights: [query] }]));
  });
  installFetch(fetchMock);
  try {
    const provider = makeProvider();
    const started = performance.now();
    const settled = await Promise.all(
      ["alpha", "beta", "gamma", "delta"].map((query) => provider.search({ query })),
    );
    const elapsed = performance.now() - started;
    assertEqual(settled.length, 4, "all four queries settled");
    assertDeepEqual(
      settled.map((r) => new URL(r.sources[0].url).pathname.slice(1)),
      ["alpha", "beta", "gamma", "delta"],
      "each query receives its own result",
    );
    assert(maxInFlight <= 2, `max concurrent fetch was ${maxInFlight}, expected <= 2`);
    assert(elapsed < 5000, `fan-out completed without deadlock (${elapsed.toFixed(0)}ms)`);
  } finally {
    restoreFetch();
  }
});

/* ------------------------------------------------------------------ */
/* 8. config / apply                                                   */
/* ------------------------------------------------------------------ */
function fakeContext(envEntries = {}) {
  const captured = [];
  const environment = {
    get(envName) {
      const value = envEntries[envName];
      return value === undefined ? undefined : { value };
    },
  };
  const ctx = {
    get(key) {
      return key === "launchEnvironment" ? environment : undefined;
    },
    effect(fn) {
      const dispose = fn();
      return async () => {
        if (typeof dispose === "function") await dispose();
      };
    },
    on() {
      return () => {};
    },
    logger: { warn() {}, info() {}, error() {} },
    web: {
      registerSearchProvider(provider) {
        captured.push(provider);
        return () => {};
      },
    },
  };
  return { ctx, captured };
}

await test("8a. apply({}) registers provider id exa with defaults", async () => {
  const { ctx, captured } = fakeContext({});
  apply(ctx, {});
  assertEqual(captured.length, 1, "registerSearchProvider call count");
  const provider = captured[0];
  assertEqual(provider.id, "exa", "provider id");
  assertEqual(PROVIDER_ID, "exa", "PROVIDER_ID export");
  assertEqual(name, "exa-web-search", "plugin name");
  assertDeepEqual(inject, ["web"], "inject list");
  assertEqual(provider.options.mode, "auto", "mode default");
  assertEqual(provider.options.mcpURL, DEFAULT_MCP_URL, "mcpURL default");
  assertEqual(provider.options.highlightsPerResult, 1, "highlightsPerResult default");
  assertEqual(provider.options.numResults, undefined, "numResults stays undefined");
  assertEqual(provider.keyed.options.apiKey, "", "no key -> empty keyed apiKey");
  assertEqual(provider.keyed.options.baseURL, "https://api.exa.ai", "baseURL default");
  assertEqual(provider.keyed.options.searchType, "auto", "searchType default");
  assertEqual(provider.keyed.options.highlightsPerResult, 1, "keyed highlightsPerResult default");
  assertEqual(provider.keyed.options.numResults, undefined, "keyed numResults undefined");
});

await test("8b. apiKey vs apiKeyEnv precedence", async () => {
  {
    const { ctx, captured } = fakeContext({ EXA_API_KEY: "env-default", MY_EXA: "env-custom" });
    apply(ctx, { apiKey: "literal-key", apiKeyEnv: "MY_EXA" });
    assertEqual(captured[0].keyed.options.apiKey, "literal-key", "literal apiKey wins");
  }
  {
    const { ctx, captured } = fakeContext({ EXA_API_KEY: "env-default", MY_EXA: "env-custom" });
    apply(ctx, { apiKeyEnv: "MY_EXA" });
    assertEqual(captured[0].keyed.options.apiKey, "env-custom", "custom apiKeyEnv consulted");
  }
  {
    const { ctx, captured } = fakeContext({ EXA_API_KEY: "env-default" });
    apply(ctx, {});
    assertEqual(captured[0].keyed.options.apiKey, "env-default", "default EXA_API_KEY consulted");
  }
});

await test("8c. apply passes mode through and ignores the removed legacy fields", async () => {
  const { ctx, captured } = fakeContext({});
  apply(ctx, { mode: "anonymous", numResults: 5, highlightsPerResult: 3 });
  const provider = captured[0];
  assertEqual(provider.options.mode, "anonymous", "mode passthrough");
  assertEqual(provider.options.numResults, undefined, "removed numResults field is ignored");
  assertEqual(provider.options.highlightsPerResult, 1, "highlightsPerResult is locked to 1");
  assertEqual(provider.keyed.options.numResults, undefined, "keyed numResults stays undefined");
  assertEqual(provider.keyed.options.highlightsPerResult, 1, "keyed highlightsPerResult locked to 1");

  const config = Config({ mode: "auto" });
  assertEqual(config.mode, "auto", "Config accepts valid mode");
});

/* ------------------------------------------------------------------ */
/* 9. keyed auto-switch                                                */
/* ------------------------------------------------------------------ */
await test("9a. keyed available() true -> search delegates, no anonymous fetch", async () => {
  let fetchCount = 0;
  installFetch(async () => {
    fetchCount += 1;
    return sseResponse(advancedEnvelope([]));
  });
  try {
    let delegated = 0;
    const keyed = stubKeyed({
      available: true,
      search: async (request, signal) => {
        delegated += 1;
        assertEqual(request.query, "keyed query", "request forwarded");
        assert(signal === undefined, "signal forwarded as undefined");
        return { sources: [{ url: "https://keyed.example", summary: "keyed summary" }], truncated: false };
      },
    });
    const result = await makeProvider({ mode: "auto" }, keyed).search({ query: "keyed query" });
    assertEqual(delegated, 1, "keyed search called");
    assertEqual(fetchCount, 0, "anonymous fetch untouched");
    assertEqual(result.sources[0].url, "https://keyed.example", "keyed result returned");
  } finally {
    restoreFetch();
  }
});

await test("9b. keyed available() false -> anonymous path", async () => {
  let fetchCount = 0;
  installFetch(async () => {
    fetchCount += 1;
    return sseResponse(advancedEnvelope([{ url: "https://anon.example", highlights: ["anon"] }]));
  });
  try {
    const result = await makeProvider({ mode: "auto" }, stubKeyed({ available: false })).search({ query: "anon query" });
    assertEqual(fetchCount, 1, "anonymous fetch used");
    assertEqual(result.sources[0].url, "https://anon.example", "anonymous result returned");
  } finally {
    restoreFetch();
  }
});

await test(
  '9c. keyed error message "Invalid API key" -> INVALID_CREDENTIAL',
  async () => {
    let fetchCount = 0;
    installFetch(async () => {
      fetchCount += 1;
      return sseResponse(advancedEnvelope([]));
    });
    try {
      const credentialError = new Error("Invalid API key");
      credentialError.code = "WEB_PROVIDER_ERROR";
      const keyed = stubKeyed({
        available: true,
        search: async () => {
          throw credentialError;
        },
      });
      const { error } = await capture(makeProvider({ mode: "auto" }, keyed).search({ query: "bad key" }));
      assert(error != null, "expected throw");
      assertEqual(error.code, "INVALID_CREDENTIAL", "error code");
      assertEqual(error.cause, credentialError, "original error preserved as cause");
      assertEqual(fetchCount, 0, "must not degrade to anonymous");
    } finally {
      restoreFetch();
    }
  },
  { knownBug: true },
);

await test("9d. keyed INVALID_API_KEY / HTTP 401 messages still convert (control)", async () => {
  installFetch(async () => sseResponse(advancedEnvelope([])));
  try {
    for (const message of ["Exa API error: INVALID_API_KEY", "Exa API error (HTTP 401)"]) {
      const credentialError = new Error(message);
      credentialError.code = "WEB_PROVIDER_ERROR";
      const keyed = stubKeyed({ available: true, search: async () => { throw credentialError; } });
      const { error } = await capture(makeProvider({ mode: "auto" }, keyed).search({ query: "bad key" }));
      assertEqual(error?.code, "INVALID_CREDENTIAL", `"${message}" converts`);
      assertEqual(error?.cause, credentialError, `"${message}" cause preserved`);
    }
  } finally {
    restoreFetch();
  }
});

/* ------------------------------------------------------------------ */
/* 10. available() checks                                              */
/* ------------------------------------------------------------------ */
await test("10. available() config checks", async () => {
  const keyedTrue = stubKeyed({ available: true });
  const keyedFalse = stubKeyed({ available: false });

  assertEqual(makeProvider({ mcpURL: "not a url" }, keyedFalse).available(), false, "malformed mcpURL -> unavailable");
  assertEqual(makeProvider({ mcpURL: "" }, keyedFalse).available(), false, "empty mcpURL -> unavailable");
  assertEqual(makeProvider({ mcpURL: MCP_URL, highlightsPerResult: 0 }, keyedFalse).available(), false, "highlightsPerResult 0 -> unavailable");
  assertEqual(makeProvider({ mcpURL: MCP_URL, highlightsPerResult: 1.5 }, keyedFalse).available(), false, "fractional highlightsPerResult -> unavailable");
  assertEqual(makeProvider({ mcpURL: MCP_URL, highlightsPerResult: "1" }, keyedFalse).available(), false, "string highlightsPerResult -> unavailable");
  assertEqual(makeProvider({ mcpURL: MCP_URL, highlightsPerResult: 1 }, keyedFalse).available(), true, "valid anonymous config -> available");
  assertEqual(makeProvider({ mode: "auto" }, keyedFalse).available(), true, "auto available via anonymous fallback even without key");
  assertEqual(makeProvider({ mode: "keyed" }, keyedFalse).available(), false, "keyed without key -> unavailable");
  assertEqual(makeProvider({ mode: "keyed" }, keyedTrue).available(), true, "keyed with key -> available");

  const { ctx, captured } = fakeContext({});
  apply(ctx, { mode: "keyed" });
  assertEqual(captured[0].available(), false, "apply keyed mode with no env key -> unavailable");
  assertEqual(captured[0].options.mode, "keyed", "apply keyed mode retained");
});

/* ------------------------------------------------------------------ */
/* summary                                                             */
/* ------------------------------------------------------------------ */
await delay(20);
const failures = results.filter((r) => r.status === "FAIL");
const bugs = results.filter((r) => r.status === "BUG");
const passes = results.filter((r) => r.status === "PASS");
const totalMs = results.reduce((sum, r) => sum + r.ms, 0);

console.log("\n================ SUMMARY ================");
console.log(`PASS ${passes.length}   FAIL ${failures.length}   BUG ${bugs.length}   (${results.length} tests, ${(totalMs / 1000).toFixed(1)}s test time)`);
if (failures.length > 0) {
  console.log("\nFAILURES:");
  for (const failure of failures) console.log(`- ${failure.name}: ${failure.detail}`);
}
if (bugs.length > 0) {
  console.log("\nCONFIRMED BUGS (expected contract not met):");
  for (const bug of bugs) console.log(`- ${bug.name}: ${bug.detail}`);
}
console.log("=========================================");
process.exitCode = failures.length > 0 ? 1 : 0;
