/**
 * One live anonymous search against https://mcp.exa.ai/mcp.
 * Run: npm run test:live
 * Hits the endpoint at most twice (advanced request + one possible legacy fallback / 429 retry).
 */
import { ExaWebSearchProvider } from "../lib/index.js";

const provider = new ExaWebSearchProvider(
  {
    mode: "anonymous",
    mcpURL: "https://mcp.exa.ai/mcp",
    highlightsPerResult: 1,
    numResults: 2,
  },
  {
    available() {
      return false;
    },
    async search() {
      throw new Error("keyed provider must not be used in live anonymous test");
    },
  },
);

const controller = new AbortController();
const timeout = setTimeout(() => controller.abort("live test timeout"), 30000);
const started = performance.now();

try {
  const result = await provider.search({ query: "DeepSeek Harness" }, controller.signal);
  const elapsed = performance.now() - started;
  const valid = result.sources.filter(
    (source) => typeof source.url === "string" && source.url.length > 0 && typeof source.summary === "string" && source.summary.trim().length > 0,
  );
  console.log(JSON.stringify({
    ok: valid.length >= 1,
    elapsedMs: Math.round(elapsed),
    truncated: result.truncated,
    sourceCount: result.sources.length,
    validSourceCount: valid.length,
    sources: valid.slice(0, 2).map((source) => ({
      url: source.url,
      title: source.title,
      summaryPreview: `${source.summary.slice(0, 160)}${source.summary.length > 160 ? "…" : ""}`,
      publishedAt: source.publishedAt,
    })),
  }, null, 2));
  if (valid.length < 1) {
    console.error(`LIVE FAIL: expected at least one source with url + summary; got ${result.sources.length} source(s): ${JSON.stringify(result.sources)}`);
    process.exitCode = 1;
  }
} catch (error) {
  console.error("LIVE FAIL:", JSON.stringify({
    name: error?.name,
    code: error?.code,
    message: error?.message,
    cause: error?.cause === undefined ? undefined : String(error.cause),
  }, null, 2));
  process.exitCode = 1;
} finally {
  clearTimeout(timeout);
}
