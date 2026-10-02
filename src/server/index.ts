import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { TtlCache } from "../qloo/cache.js";
import { FixtureQlooClient } from "../qloo/fixtures/client.js";
import { McpQlooClient, resolveQlooCommand } from "../qloo/mcp-client.js";
import { QlooService } from "../qloo/service.js";
import type { QlooEnvelope, QlooToolClient } from "../qloo/types.js";
import { createApp } from "./app.js";
import { loadConfig, readinessProblems } from "./config.js";
import { createLlm, startupLines } from "./planner.js";

// .env is a local-development convenience. In Docker/production the variables come from the runtime environment.
try {
  process.loadEnvFile();
} catch {
  /* no .env file: fine */
}

const config = loadConfig();
const sample = config.demoFixtures;
const problems = readinessProblems(config);

const here = dirname(fileURLToPath(import.meta.url));
// Both src/server (tsx) and dist/server (built) sit two levels below the project root.
const root = resolve(here, "..", "..");
const webCandidate = resolve(root, "dist/web");
const webRoot = existsSync(resolve(webCandidate, "index.html")) ? webCandidate : undefined;

let client: QlooToolClient;
if (sample) {
  client = new FixtureQlooClient();
} else {
  // Live mode never falls back to fixtures. Without keys, runs are refused with a clear "not configured" message.
  client = new McpQlooClient(resolveQlooCommand(), process.env);
}

const qloo = new QlooService({
  client,
  cache: new TtlCache<QlooEnvelope>(config.cache.ttlMs, config.cache.maxEntries),
  dailyCallBudget: config.limits.dailyCallBudget,
  timeoutMs: config.agent.qlooTimeoutMs,
  concurrency: config.agent.qlooConcurrency,
});

const llm = createLlm(config, sample);

// Warm the long-lived `qloo mcp` child so the first visitor does not pay for the process start (no Qloo network call).
if (!sample) {
  void client.readiness().then((r) => console.log(r.ready ? "qloo mcp: started, credential present." : `qloo mcp: started, but not ready for live calls${r.detail ? ` (${r.detail})` : ""}.`));
}

const app = createApp({ config, qloo, llm, sample, ...(webRoot ? { webRoot } : {}) });

app.server.listen(config.port, config.host, () => {
  const where = `http://${config.host === "0.0.0.0" ? "localhost" : config.host}:${config.port}`;
  console.log(`Shelfwise listening on ${config.host}:${config.port} (${where})`);
  for (const line of startupLines(config, sample, llm)) console.log(line);
  console.log(webRoot ? `Serving web app from ${webRoot}` : "Web app not built; serving API only (npm run build:web).");
  for (const p of config.parseProblems) console.warn(`Config warning: ${p}`);
  for (const p of problems) console.warn(`NOT READY: ${p}`);
});

let stopping = false;
async function shutdown(signal: string): Promise<void> {
  if (stopping) return;
  stopping = true;
  console.log(`${signal} received, shutting down.`);
  const force = setTimeout(() => process.exit(1), 8000);
  force.unref();
  await app.close();
  await client.close().catch(() => undefined);
  process.exit(0);
}
process.on("SIGINT", () => void shutdown("SIGINT"));
process.on("SIGTERM", () => void shutdown("SIGTERM"));
