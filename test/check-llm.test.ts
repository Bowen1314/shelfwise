import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { type IncomingMessage, type ServerResponse, createServer } from "node:http";
import { fileURLToPath } from "node:url";
import { describe, it } from "node:test";

const SCRIPT = fileURLToPath(new URL("../scripts/check-llm.mjs", import.meta.url));
const MODEL = "nvidia/nemotron-3-super-120b-a12b";

function run(env: Record<string, string>): Promise<{ code: number; out: string }> {
  return new Promise((resolve) => {
    // A clean environment: no .env is read from the project dir because cwd is a temp location.
    execFile(process.execPath, [SCRIPT], { env: { PATH: process.env["PATH"] ?? "", ...env }, cwd: "/tmp", timeout: 20_000 }, (error, stdout, stderr) => {
      const code = error && typeof (error as { code?: unknown }).code === "number" ? ((error as { code: number }).code) : error ? 99 : 0;
      resolve({ code, out: `${stdout}${stderr}` });
    });
  });
}

function readJson(req: IncomingMessage): Promise<Record<string, unknown>> {
  return new Promise((resolve) => {
    let body = "";
    req.on("data", (c: Buffer) => (body += c.toString()));
    req.on("end", () => resolve(body ? (JSON.parse(body) as Record<string, unknown>) : {}));
  });
}

interface Mock {
  url: string;
  seen: { path: string; auth: string | undefined; body: Record<string, unknown> }[];
  close(): Promise<void>;
}

async function mockServer(behaviour: { callsTools: boolean; features?: string[] }): Promise<Mock> {
  const seen: Mock["seen"] = [];
  const server = createServer(async (req: IncomingMessage, res: ServerResponse) => {
    const body = await readJson(req);
    seen.push({ path: req.url ?? "", auth: req.headers.authorization, body });
    res.setHeader("Content-Type", "application/json");
    if (req.url?.startsWith("/v1/models")) {
      res.end(JSON.stringify({ data: [{ id: MODEL, supported_features: behaviour.features ?? ["tools", "json_mode"] }] }));
      return;
    }
    const messages = body["messages"] as { role: string }[];
    const hasToolResult = messages.some((m) => m.role === "tool");
    if (behaviour.callsTools && !hasToolResult) {
      res.end(JSON.stringify({ choices: [{ finish_reason: "tool_calls", message: { role: "assistant", content: null, tool_calls: [{ id: "call_1", type: "function", function: { name: "add", arguments: JSON.stringify({ a: 17, b: 25 }) } }] } }] }));
    } else {
      res.end(JSON.stringify({ choices: [{ finish_reason: "stop", message: { role: "assistant", content: behaviour.callsTools ? "17 plus 25 is 42." : "It is 42, no tool needed." } }] }));
    }
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const port = (server.address() as { port: number }).port;
  return { url: `http://127.0.0.1:${port}/v1/`, seen, close: () => new Promise<void>((r) => (server.closeAllConnections(), server.close(() => r()))) };
}

describe("scripts/check-llm.mjs", () => {
  it("exits 2 with a clear message when no key is set (and never prints one)", async () => {
    const r = await run({});
    assert.equal(r.code, 2);
    assert.match(r.out, /set NEBIUS_API_KEY/);
    assert.match(r.out, /api\.tokenfactory\.nebius\.com\/v1\//);
    assert.match(r.out, new RegExp(MODEL));
  });

  it("ignores generic variable names: another tool's LLM_API_KEY/OPENAI_API_KEY is never used or sent anywhere", async () => {
    const m = await mockServer({ callsTools: true });
    try {
      const r = await run({ LLM_API_KEY: "not-ours", OPENAI_API_KEY: "not-ours-either", LLM_BASE_URL: m.url, LLM_MODEL: "other-tools-model" });
      assert.equal(r.code, 2, r.out);
      assert.match(r.out, /set NEBIUS_API_KEY/);
      assert.ok(r.out.includes(MODEL), "the default model is shown, not LLM_MODEL");
      assert.ok(r.out.includes("api.tokenfactory.nebius.com"), "the default base URL is shown, not LLM_BASE_URL");
      assert.equal(m.seen.length, 0, "nothing was sent to the endpoint named by LLM_BASE_URL");
    } finally {
      await m.close();
    }
  });

  it("prints supported_features and passes when the model calls tools (no parallel_tool_calls)", async () => {
    const m = await mockServer({ callsTools: true, features: ["tools", "json_mode"] });
    try {
      const r = await run({ NEBIUS_API_KEY: "secret-test-key", SHELFWISE_LLM_BASE_URL: m.url });
      assert.equal(r.code, 0, r.out);
      assert.match(r.out, /supported_features for nvidia\/nemotron-3-super-120b-a12b: \["tools","json_mode"\]/);
      assert.match(r.out, /Round trip 1\/2: model called add\(\{"a":17,"b":25\}\)/);
      assert.match(r.out, /Forced tool_choice: ok/);
      assert.match(r.out, /Result: OK/);
      assert.ok(!r.out.includes("secret-test-key"), "the key is never printed");
      assert.ok(m.seen.every((s) => s.auth === "Bearer secret-test-key"));
      const chats = m.seen.filter((s) => s.path.endsWith("/chat/completions"));
      assert.equal(chats.length, 3);
      assert.ok(chats.every((c) => !("parallel_tool_calls" in c.body) && !("response_format" in c.body)));
      assert.deepEqual(chats[2]!.body["tool_choice"], { type: "function", function: { name: "add" } });
      assert.ok(m.seen.some((s) => s.path === "/v1/models?verbose=true"));
    } finally {
      await m.close();
    }
  });

  it("fails (exit 1) when the model answers without calling the tool", async () => {
    const m = await mockServer({ callsTools: false });
    try {
      const r = await run({ NEBIUS_API_KEY: "k", SHELFWISE_LLM_BASE_URL: m.url });
      assert.equal(r.code, 1, r.out);
      assert.match(r.out, /Tool-calling round trip FAILED/);
    } finally {
      await m.close();
    }
  });

  it("warns when the model does not advertise tool calling", async () => {
    const m = await mockServer({ callsTools: true, features: ["json_mode"] });
    try {
      const r = await run({ NEBIUS_API_KEY: "k", SHELFWISE_LLM_BASE_URL: m.url });
      assert.match(r.out, /does not advertise tool\/function calling/);
    } finally {
      await m.close();
    }
  });
});
