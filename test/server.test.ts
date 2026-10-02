import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createServer, request as httpRequest } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, it } from "node:test";
import { ScriptedDemoLlm } from "../src/agent/demo-llm.js";
import { TtlCache } from "../src/qloo/cache.js";
import { FixtureQlooClient } from "../src/qloo/fixtures/client.js";
import { QlooService } from "../src/qloo/service.js";
import type { CallOptions, JsonObject, QlooEnvelope, QlooToolClient } from "../src/qloo/types.js";
import { type App, createApp } from "../src/server/app.js";
import { loadConfig } from "../src/server/config.js";
import { type PlannerLlm, createLlm } from "../src/server/planner.js";
import { type AgentEvent, type ApiError, type FormInput, type HealthResponse, type Healthz, LIMITS_LINE, type Report } from "../src/shared/types.js";

// ------------------------------------------------------------------------------------------------
// Harness
// ------------------------------------------------------------------------------------------------

type Env = Record<string, string | undefined>;

interface Started {
  app: App;
  base: string;
  client: QlooToolClient;
  close(): Promise<void>;
}

interface StartOptions {
  env?: Env;
  latencyMs?: number;
  /** false = live mode with no keys (no DEMO_FIXTURES). */
  demo?: boolean;
  sample?: boolean;
  client?: QlooToolClient;
  webRoot?: string;
  now?: () => number;
  heartbeatMs?: number;
  /** Defaults to the scripted planner. */
  llm?: PlannerLlm;
}

async function start(opts: StartOptions = {}): Promise<Started> {
  const demo = opts.demo ?? true;
  const config = loadConfig({
    ...(demo ? { DEMO_FIXTURES: "1" } : {}),
    // generous defaults so only the tests that are about limits ever hit one
    RATE_LIMIT_RUNS_PER_HOUR: "1000",
    RATE_LIMIT_MESSAGES_PER_HOUR: "1000",
    AGENT_RETRY_BASE_MS: "0",
    ...opts.env,
  });
  const client = opts.client ?? new FixtureQlooClient(opts.latencyMs ?? 0);
  const qloo = new QlooService({
    client,
    cache: new TtlCache<QlooEnvelope>(config.cache.ttlMs, config.cache.maxEntries),
    dailyCallBudget: config.limits.dailyCallBudget,
    timeoutMs: config.agent.qlooTimeoutMs,
    concurrency: config.agent.qlooConcurrency,
  });
  const app = createApp({
    config,
    qloo,
    llm: opts.llm ?? new ScriptedDemoLlm(),
    sample: opts.sample ?? true,
    ...(opts.webRoot ? { webRoot: opts.webRoot } : {}),
    ...(opts.now ? { now: opts.now } : {}),
    ...(opts.heartbeatMs ? { heartbeatMs: opts.heartbeatMs } : {}),
  });
  await new Promise<void>((resolve, reject) => {
    app.server.once("error", reject);
    app.server.listen(0, "127.0.0.1", resolve);
  });
  const { port } = app.server.address() as AddressInfo;
  return { app, base: `http://127.0.0.1:${port}`, client, close: () => app.close() };
}

async function withApp<T>(opts: StartOptions, fn: (s: Started) => Promise<T>): Promise<T> {
  const s = await start(opts);
  try {
    return await fn(s);
  } finally {
    await s.close();
  }
}

// ---- SSE ----------------------------------------------------------------------------------------

interface Frames {
  events: AgentEvent[];
  comments: string[];
  /** Bytes left over after the last blank line (an incomplete frame). */
  rest: string;
}

function parseSse(text: string): Frames {
  const events: AgentEvent[] = [];
  const comments: string[] = [];
  const parts = text.split("\n\n");
  const rest = parts.pop() ?? "";
  for (const frame of parts) {
    const lines = frame.split("\n").filter((l) => l !== "");
    if (lines.length > 0 && lines.every((l) => l.startsWith(":"))) {
      comments.push(...lines);
      continue;
    }
    let name: string | undefined;
    let data = "";
    for (const line of lines) {
      if (line.startsWith(":")) comments.push(line);
      else if (line.startsWith("event: ")) name = line.slice("event: ".length);
      else if (line.startsWith("data: ")) data += line.slice("data: ".length);
      else assert.fail(`unexpected SSE line: ${JSON.stringify(line)}`);
    }
    const event = JSON.parse(data) as AgentEvent;
    assert.equal(name, event.type, "the SSE event name must equal the payload type");
    events.push(event);
  }
  return { events, comments, rest };
}

function only<T extends AgentEvent["type"]>(events: AgentEvent[], type: T): Extract<AgentEvent, { type: T }>[] {
  return events.filter((e): e is Extract<AgentEvent, { type: T }> => e.type === type);
}

const types = (events: AgentEvent[]): string[] => events.map((e) => e.type);

interface RunResponse {
  status: number;
  headers: Headers;
  events: AgentEvent[];
  comments: string[];
  raw: string;
  error: ApiError["error"] | undefined;
}

async function readRun(res: Response): Promise<RunResponse> {
  const raw = await res.text();
  const contentType = res.headers.get("content-type") ?? "";
  if (contentType.startsWith("text/event-stream")) {
    const frames = parseSse(raw);
    assert.equal(frames.rest.trim(), "", "the stream must end on a complete frame");
    return { status: res.status, headers: res.headers, events: frames.events, comments: frames.comments, raw, error: undefined };
  }
  let error: ApiError["error"] | undefined;
  if (contentType.startsWith("application/json")) error = (JSON.parse(raw) as ApiError).error;
  return { status: res.status, headers: res.headers, events: [], comments: [], raw, error };
}

interface PostOptions {
  headers?: Record<string, string>;
  signal?: AbortSignal;
}

function postInit(body: unknown, opts: PostOptions = {}): RequestInit {
  return {
    method: "POST",
    headers: { "Content-Type": "application/json", ...opts.headers },
    body: typeof body === "string" ? body : JSON.stringify(body),
    ...(opts.signal ? { signal: opts.signal } : {}),
  };
}

async function postRun(base: string, body: unknown, opts: PostOptions = {}): Promise<RunResponse> {
  return readRun(await fetch(`${base}/api/runs`, postInit(body, opts)));
}

/** A run whose stream is read incrementally, so tests can act while it is still going. */
class LiveRun {
  readonly events: AgentEvent[] = [];
  private buffer = "";
  private ended = false;
  private constructor(
    readonly response: Response,
    private readonly reader: ReadableStreamDefaultReader<Uint8Array>,
    private readonly controller: AbortController,
  ) {}

  static async start(base: string, body: unknown, opts: PostOptions = {}): Promise<LiveRun> {
    const controller = new AbortController();
    const response = await fetch(`${base}/api/runs`, postInit(body, { ...opts, signal: controller.signal }));
    assert.equal(response.status, 200, `expected a stream, got ${response.status}`);
    assert.ok(response.body, "no response body");
    return new LiveRun(response, response.body.getReader(), controller);
  }

  /** Reads one chunk. False once the stream has ended (or was aborted). */
  private async pump(): Promise<boolean> {
    if (this.ended) return false;
    let chunk: { done: boolean; value?: Uint8Array };
    try {
      chunk = await this.reader.read();
    } catch {
      this.ended = true;
      return false;
    }
    if (chunk.done) {
      this.ended = true;
      return false;
    }
    this.buffer += new TextDecoder().decode(chunk.value, { stream: true });
    const frames = parseSse(this.buffer);
    this.buffer = frames.rest;
    this.events.push(...frames.events);
    return true;
  }

  async waitFor(predicate: (e: AgentEvent) => boolean): Promise<AgentEvent> {
    let seen = 0;
    for (;;) {
      for (; seen < this.events.length; seen++) {
        const e = this.events[seen]!;
        if (predicate(e)) return e;
      }
      if (!(await this.pump())) assert.fail(`stream ended before the awaited event; saw: ${types(this.events).join(",")}`);
    }
  }

  get sessionId(): string {
    const s = this.events.find((e) => e.type === "session");
    assert.ok(s && s.type === "session", "no session event yet");
    return s.sessionId;
  }

  async finish(): Promise<AgentEvent[]> {
    while (await this.pump()) {
      /* keep reading */
    }
    return this.events;
  }

  abort(): void {
    this.controller.abort();
  }
}

async function waitUntil(condition: () => boolean, timeoutMs = 2_000, stepMs = 10): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!condition()) {
    if (Date.now() > deadline) assert.fail(`condition not met within ${timeoutMs}ms`);
    await new Promise((resolve) => setTimeout(resolve, stepMs));
  }
}

// ---- requests -----------------------------------------------------------------------------------

const getJson = async <T>(url: string): Promise<{ status: number; headers: Headers; body: T }> => {
  const res = await fetch(url);
  return { status: res.status, headers: res.headers, body: (await res.json()) as T };
};

const formBody = (form: FormInput | Record<string, unknown>): unknown => ({ input: { kind: "form", form } });
const messageBody = (sessionId: string, text: string): unknown => ({ sessionId, input: { kind: "message", text } });

async function samples(base: string): Promise<FormInput[]> {
  const { body } = await getJson<HealthResponse>(`${base}/api/health`);
  assert.ok(body.sampleInputs.length > 0);
  return body.sampleInputs;
}

const sessionOf = (events: AgentEvent[]): string => {
  const s = only(events, "session")[0];
  assert.ok(s, "no session event");
  return s.sessionId;
};

const lastDone = (events: AgentEvent[]): Extract<AgentEvent, { type: "done" }> => {
  const d = only(events, "done").at(-1);
  assert.ok(d, "no done event");
  return d;
};

const reportOf = (events: AgentEvent[]): Report => {
  const r = only(events, "report").at(-1);
  assert.ok(r, `no report event; saw ${types(events).join(",")}`);
  return r.report;
};

function namesIn(value: unknown, out: Set<string> = new Set()): Set<string> {
  if (Array.isArray(value)) for (const v of value) namesIn(v, out);
  else if (value && typeof value === "object") {
    for (const [k, v] of Object.entries(value)) {
      if (k === "name" && typeof v === "string") out.add(v);
      else namesIn(v, out);
    }
  }
  return out;
}

const DUNE = (all: FormInput[]): FormInput => {
  const f = all.find((i) => /Dune/.test(i.interests));
  assert.ok(f, "no sample input mentions Dune");
  return f;
};

/** A FixtureQlooClient that counts how many calls reach it. */
class CountingClient extends FixtureQlooClient {
  calls = 0;
  override async call(name: string, args: JsonObject, opts?: CallOptions): Promise<QlooEnvelope> {
    this.calls += 1;
    return super.call(name, args, opts);
  }
}

const SECURITY_HEADERS = (res: { headers: Headers }, where: string): void => {
  assert.match(res.headers.get("content-security-policy") ?? "", /default-src 'self'/, `${where}: CSP`);
  assert.equal(res.headers.get("x-content-type-options"), "nosniff", `${where}: nosniff`);
  assert.equal(res.headers.get("referrer-policy"), "no-referrer", `${where}: referrer-policy`);
  assert.equal(res.headers.get("x-frame-options"), "DENY", `${where}: x-frame-options`);
};

// ------------------------------------------------------------------------------------------------
// Health, security headers, errors (one shared app: none of these tests use up a limit)
// ------------------------------------------------------------------------------------------------

describe("health and security headers", { timeout: 30_000 }, () => {
  let s: Started;
  before(async () => {
    s = await start();
  });
  after(async () => {
    await s.close();
  });

  it("GET /healthz answers {ok:true, mode:'sample-data', mcp:null}", async () => {
    const r = await getJson<Healthz>(`${s.base}/healthz`);
    assert.equal(r.status, 200);
    assert.deepEqual(r.body, { ok: true, mode: "sample-data", mcp: null });
    assert.match(r.headers.get("content-type") ?? "", /^application\/json/);
    const head = await fetch(`${s.base}/healthz`, { method: "HEAD" });
    assert.equal(head.status, 200);
    assert.equal(await head.text(), "");
  });

  it("GET /api/health describes a ready fixtures-mode server", async () => {
    const r = await getJson<HealthResponse>(`${s.base}/api/health`);
    assert.equal(r.status, 200);
    assert.equal(r.headers.get("cache-control"), "no-store");
    const h = r.body;
    assert.equal(h.ok, true);
    assert.equal(h.mode, "fixtures");
    assert.equal(h.ready, true);
    assert.deepEqual(h.problems, []);
    assert.equal(h.llm.scripted, true);
    assert.deepEqual(h.qloo, { sample: true, mcpUp: null });
    assert.ok(h.sampleInputs.length > 0);
    for (const input of h.sampleInputs) {
      assert.equal(typeof input.place, "string");
      assert.equal(typeof input.interests, "string");
      assert.ok(input.titleCount >= 3 && input.titleCount <= 20);
    }
    assert.equal(typeof h.limitsLine, "string");
    assert.ok(h.limitsLine.length > 0);
    assert.equal(h.limitsLine, LIMITS_LINE);
    assert.equal(h.limits.maxConcurrentRuns, 2);
    assert.equal(h.limits.runsPerHour, 1000);
  });

  it("sets the security headers on every kind of response", async () => {
    const form = (await samples(s.base))[0]!;
    const checks: [string, () => Promise<Response>][] = [
      ["GET /healthz", () => fetch(`${s.base}/healthz`)],
      ["HEAD /healthz", () => fetch(`${s.base}/healthz`, { method: "HEAD" })],
      ["GET /api/health", () => fetch(`${s.base}/api/health`)],
      ["GET /api/nope (404)", () => fetch(`${s.base}/api/nope`)],
      ["GET /api/runs (405)", () => fetch(`${s.base}/api/runs`)],
      ["POST /api/runs bad JSON (400)", () => fetch(`${s.base}/api/runs`, postInit("{nope"))],
      ["POST /api/runs text/plain (415)", () => fetch(`${s.base}/api/runs`, { method: "POST", headers: { "Content-Type": "text/plain" }, body: "x" })],
      ["GET / (404 text)", () => fetch(`${s.base}/`)],
      ["POST / (405)", () => fetch(`${s.base}/`, { method: "POST" })],
      ["POST /api/runs (SSE)", () => fetch(`${s.base}/api/runs`, postInit(formBody(form)))],
    ];
    for (const [where, go] of checks) {
      const res = await go();
      SECURITY_HEADERS(res, where);
      await res.text();
    }
  });

  it("answers errors as JSON with {error:{code,message}} and no caching", async () => {
    const res = await fetch(`${s.base}/api/nope`);
    assert.equal(res.status, 404);
    assert.match(res.headers.get("content-type") ?? "", /^application\/json/);
    assert.equal(res.headers.get("cache-control"), "no-store");
    const body = (await res.json()) as ApiError;
    assert.equal(body.error.code, "not_found");
    assert.equal(typeof body.error.message, "string");
    assert.equal(body.error.retryAfterSec, undefined);
  });
});

// ------------------------------------------------------------------------------------------------
// A full run
// ------------------------------------------------------------------------------------------------

describe("full run from the sample form", { timeout: 30_000 }, () => {
  it("streams session, started, plan, tool calls and results, a report and done(completed), in a sane order", async () => {
    await withApp({}, async ({ base, app }) => {
      const form = (await samples(base))[0]!;
      const res = await postRun(base, formBody(form));
      assert.equal(res.status, 200);
      assert.match(res.headers.get("content-type") ?? "", /^text\/event-stream/);
      assert.match(res.headers.get("cache-control") ?? "", /no-store/);
      const ev = res.events;
      const t = types(ev);

      assert.equal(t[0], "session", "the session event comes first so the client can keep the id");
      const session = ev[0];
      assert.ok(session && session.type === "session");
      assert.match(session.sessionId, /^[a-f0-9]{32}$/);
      assert.match(session.runId, /^[a-f0-9]+$/);
      assert.equal(session.mode, "fixtures");

      for (const needed of ["started", "plan", "tool_call", "tool_result", "report", "done"]) assert.ok(t.includes(needed), `missing ${needed}; saw ${t.join(",")}`);
      assert.ok(t.indexOf("session") < t.indexOf("started"));
      assert.ok(t.indexOf("started") < t.indexOf("plan"));
      assert.ok(t.indexOf("plan") < t.indexOf("tool_call"));
      assert.ok(t.indexOf("tool_call") < t.indexOf("tool_result"));
      assert.ok(t.indexOf("tool_result") < t.indexOf("report"));
      assert.ok(t.lastIndexOf("tool_result") < t.indexOf("report"), "the report comes after the last tool result");
      assert.equal(t.at(-1), "done");
      assert.equal(only(ev, "done").length, 1);
      assert.equal(only(ev, "report").length, 1);
      assert.equal(only(ev, "error").length, 0);
      assert.equal(only(ev, "queued").length, 0, "nobody was ahead of this run");

      const done = lastDone(ev);
      assert.equal(done.reason, "completed");
      assert.equal(done.toolCalls, only(ev, "tool_call").length);
      assert.ok(done.steps >= 2);

      const plan = only(ev, "plan")[0];
      assert.ok(plan && plan.steps.length >= 2);
      assert.ok(plan.steps.every((st) => typeof st.title === "string" && st.title.length > 0));

      // every tool call is answered by exactly one result with the same id, after it
      const calls = only(ev, "tool_call");
      const results = only(ev, "tool_result");
      assert.equal(calls.length, results.length);
      for (const c of calls) {
        const ri = ev.findIndex((e) => e.type === "tool_result" && e.result.callId === c.call.callId);
        assert.ok(ri > ev.indexOf(c), `${c.call.callId}: result must follow its call`);
        const result = results.find((r) => r.result.callId === c.call.callId);
        assert.equal(result?.result.tool, c.call.tool);
        assert.equal(result?.result.sample, true, "fixture results are flagged as sample");
      }

      // the report
      const report = reportOf(ev);
      assert.equal(report.sample, true);
      assert.equal(report.version, 1);
      assert.equal(report.place, form.place);
      assert.ok(report.bridgeShelf.length > 0, "bridgeShelf is empty");
      assert.ok(report.buyList.length > 0, "buyList is empty");
      assert.ok(report.programmes.length > 0, "programmes is empty");
      assert.ok(report.buyList.length <= form.titleCount);
      assert.deepEqual(
        report.buyList.map((b) => b.rank),
        report.buyList.map((_, i) => i + 1),
      );

      // provenance: nothing in the report is invented. Every title is a name Qloo (here: the fixtures) returned.
      const returned = namesIn(results.map((r) => r.result));
      const shown = new Set<string>();
      for (const card of report.bridgeShelf) {
        shown.add(card.book.name);
        for (const l of card.loved) shown.add(l.name);
      }
      for (const item of report.buyList) shown.add(item.book.name);
      for (const p of report.programmes) {
        for (const b of p.books) shown.add(b.name);
        for (const sg of p.signals) shown.add(sg.name);
      }
      assert.ok(shown.size > 0);
      for (const name of shown) assert.ok(returned.has(name), `"${name}" is in the report but in no tool_result`);
      const asJson = JSON.stringify(results.map((r) => r.result));
      for (const item of report.buyList) assert.ok(asJson.includes(item.book.name), item.book.name);
      for (const card of report.bridgeShelf) assert.ok(asJson.includes(card.book.name), card.book.name);

      // every citation points at a call that really happened in this run
      const callIds = new Set(calls.map((c) => c.call.callId));
      const cites = [...report.bridgeShelf.flatMap((c) => c.cites), ...report.buyList.flatMap((b) => b.cites), ...report.programmes.flatMap((p) => p.cites)];
      assert.ok(cites.length > 0);
      for (const c of cites) assert.ok(callIds.has(c.callId), `cite ${c.callId} does not match any tool_call`);

      // the session is stored, idle, and reusable
      const stored = app.sessions.get(session.sessionId);
      assert.ok(stored);
      assert.equal(stored.busy, false);
      assert.equal(stored.reportVersion, 1);
      assert.equal(app.queue.running, 0);
    });
  });

  it("runs every sample input to completion or to a clarification question, never to an error", async () => {
    await withApp({}, async ({ base }) => {
      for (const form of await samples(base)) {
        const res = await postRun(base, formBody(form));
        assert.equal(res.status, 200);
        assert.equal(only(res.events, "error").length, 0, `${form.interests}: ${JSON.stringify(only(res.events, "error"))}`);
        assert.ok(["completed", "awaiting_input"].includes(lastDone(res.events).reason), form.interests);
      }
    });
  });

  it("sends heartbeat comments on a slow run and they do not disturb the event stream", async () => {
    await withApp({ latencyMs: 120, heartbeatMs: 25 }, async ({ base }) => {
      const form = (await samples(base))[0]!;
      const res = await postRun(base, formBody(form));
      assert.ok(res.comments.length > 0, "no heartbeat comment was sent");
      assert.ok(res.comments.every((c) => c.startsWith(":")));
      assert.match(res.raw, /: keep-alive/);
      assert.equal(lastDone(res.events).reason, "completed");
      assert.ok(res.events.every((e) => typeof e.type === "string"));
    });
  });
});

// ------------------------------------------------------------------------------------------------
// needs_input
// ------------------------------------------------------------------------------------------------

describe("needs_input flow", { timeout: 30_000 }, () => {
  async function pausedOnDune(base: string): Promise<{ sessionId: string; issueId: string; candidates: { id: string; name: string }[]; events: AgentEvent[] }> {
    const res = await postRun(base, formBody(DUNE(await samples(base))));
    assert.equal(res.status, 200);
    const t = types(res.events);
    assert.ok(t.includes("needs_input"), `no needs_input; saw ${t.join(",")}`);
    assert.ok(!t.includes("report"));
    const needs = only(res.events, "needs_input")[0]!;
    const issue = needs.issues[0];
    assert.ok(issue);
    return { sessionId: sessionOf(res.events), issueId: issue.issueId, candidates: issue.candidates, events: res.events };
  }

  it("ends with needs_input then done(awaiting_input), offering candidates to choose from", async () => {
    await withApp({}, async ({ base, app }) => {
      const { events, sessionId } = await pausedOnDune(base);
      const t = types(events);
      assert.equal(t.at(-1), "done");
      assert.equal(t.at(-2), "needs_input");
      assert.equal(lastDone(events).reason, "awaiting_input");
      assert.equal(only(events, "error").length, 0);

      const needs = only(events, "needs_input")[0]!;
      assert.equal(needs.tool, "qloo_recommend");
      assert.match(needs.message, /Dune/);
      const issue = needs.issues[0]!;
      assert.equal(issue.kind, "ambiguous");
      assert.equal(issue.input, "Dune");
      assert.ok(issue.candidates.length >= 2);
      assert.equal(new Set(issue.candidates.map((c) => c.id)).size, issue.candidates.length);
      // the paused call's own tool_result says needs_input
      assert.ok(only(events, "tool_result").some((r) => r.result.status === "needs_input"));

      const stored = app.sessions.get(sessionId);
      assert.ok(stored && stored.pending.size > 0);
      assert.equal(stored.busy, false);
    });
  });

  it("rejects a pick that was not offered (400) and keeps the question open", async () => {
    await withApp({}, async ({ base, app }) => {
      const { sessionId, issueId, candidates } = await pausedOnDune(base);
      const bogus = await postRun(base, { sessionId, input: { kind: "resolution", choices: [{ issueId, pick: { id: "sample-sig-not-offered", name: "Dune" } }] } });
      assert.equal(bogus.status, 400);
      assert.equal(bogus.error?.code, "invalid_request");
      assert.match(bogus.error?.message ?? "", /not one of the options offered/);

      const unknownIssue = await postRun(base, { sessionId, input: { kind: "resolution", choices: [{ issueId: "c99.9", pick: null }] } });
      assert.equal(unknownIssue.status, 400);
      assert.equal(unknownIssue.error?.code, "invalid_request");

      const stored = app.sessions.get(sessionId);
      assert.ok(stored && stored.pending.size > 0, "a rejected answer must leave the question pending");
      assert.equal(stored.busy, false);
      assert.ok(candidates.length > 0);
    });
  });

  it("completes with a report after a valid pick, then refuses a second answer (409)", async () => {
    await withApp({}, async ({ base, app }) => {
      const { sessionId, issueId, candidates } = await pausedOnDune(base);
      const pick = candidates[0]!;
      const res = await postRun(base, { sessionId, input: { kind: "resolution", choices: [{ issueId, pick: { id: pick.id, name: pick.name } }] } });
      assert.equal(res.status, 200);
      assert.equal(res.events[0]?.type, "session");
      assert.equal(sessionOf(res.events), sessionId, "an answer continues the same session");
      assert.ok(types(res.events).includes("started"));
      assert.equal(only(res.events, "error").length, 0);
      assert.equal(lastDone(res.events).reason, "completed");
      const report = reportOf(res.events);
      assert.ok(report.buyList.length > 0);
      assert.equal(report.sample, true);
      // the chosen entity id was passed to Qloo, exactly as offered
      const sent = only(res.events, "tool_call").map((c) => JSON.stringify(c.call.args));
      assert.ok(sent.some((a) => a.includes(pick.id)), `pick ${pick.id} never reached a tool call: ${sent.join(" ")}`);
      assert.equal(app.sessions.get(sessionId)?.pending.size, 0);

      const again = await postRun(base, { sessionId, input: { kind: "resolution", choices: [{ issueId, pick: { id: pick.id, name: pick.name } }] } });
      assert.equal(again.status, 409);
      assert.equal(again.error?.code, "nothing_pending");
    });
  });

  it("lets the user skip the ambiguous input (pick: null) and still finish", async () => {
    await withApp({}, async ({ base }) => {
      const { sessionId, issueId } = await pausedOnDune(base);
      const res = await postRun(base, { sessionId, input: { kind: "resolution", choices: [{ issueId, pick: null }] } });
      assert.equal(res.status, 200);
      assert.equal(only(res.events, "error").length, 0);
      assert.equal(lastDone(res.events).reason, "completed");
      assert.ok(reportOf(res.events).buyList.length > 0);
    });
  });

  it("answers a resolution for a session with nothing pending with 409, not a run", async () => {
    await withApp({}, async ({ base }) => {
      const first = await postRun(base, formBody((await samples(base))[0]!));
      assert.equal(lastDone(first.events).reason, "completed");
      const res = await postRun(base, { sessionId: sessionOf(first.events), input: { kind: "resolution", choices: [{ issueId: "c1.1", pick: null }] } });
      assert.equal(res.status, 409);
      assert.equal(res.error?.code, "nothing_pending");
      assert.equal(res.events.length, 0);
    });
  });
});

// ------------------------------------------------------------------------------------------------
// Follow-ups
// ------------------------------------------------------------------------------------------------

describe("follow-up messages", { timeout: 30_000 }, () => {
  it("'make it for teens' in the same session yields report version 2 for teens", async () => {
    await withApp({}, async ({ base }) => {
      const first = await postRun(base, formBody((await samples(base))[0]!));
      assert.equal(reportOf(first.events).version, 1);
      assert.equal(reportOf(first.events).audience, "Whole community (no age focus)");
      const sessionId = sessionOf(first.events);

      const res = await postRun(base, messageBody(sessionId, "make it for teens"));
      assert.equal(res.status, 200);
      assert.equal(sessionOf(res.events), sessionId);
      assert.equal(only(res.events, "error").length, 0);
      assert.equal(lastDone(res.events).reason, "completed");
      const report = reportOf(res.events);
      assert.equal(report.version, 2);
      assert.equal(report.audience, "Teens and young adults");
      assert.equal(report.sample, true);
      assert.ok(report.buyList.length > 0);
      // the audience really was sent to Qloo
      assert.ok(only(res.events, "tool_call").some((c) => c.call.args["demographic"] === "teens"));
    });
  });

  it("answers an out-of-scope follow-up with a plain message and no new report", async () => {
    await withApp({}, async ({ base }) => {
      const first = await postRun(base, formBody((await samples(base))[0]!));
      const res = await postRun(base, messageBody(sessionOf(first.events), "what is the weather like"));
      assert.equal(res.status, 200);
      assert.equal(only(res.events, "report").length, 0);
      assert.equal(only(res.events, "message").length, 1);
      assert.equal(lastDone(res.events).reason, "completed");
    });
  });

  it("caps follow-ups per session (MAX_SESSION_FOLLOWUPS) with 429 session_limit", async () => {
    await withApp({ env: { MAX_SESSION_FOLLOWUPS: "1" } }, async ({ base, app }) => {
      const first = await postRun(base, formBody((await samples(base))[0]!));
      const sessionId = sessionOf(first.events);
      const ok = await postRun(base, messageBody(sessionId, "make it for teens"));
      assert.equal(ok.status, 200);
      assert.equal(lastDone(ok.events).reason, "completed");

      const over = await postRun(base, messageBody(sessionId, "translated fiction please"));
      assert.equal(over.status, 429);
      assert.equal(over.error?.code, "session_limit");
      assert.match(over.error?.message ?? "", /1 follow-ups/);
      assert.equal(over.events.length, 0);
      assert.equal(app.sessions.get(sessionId)?.followUps, 1, "a refused message does not count");
      assert.equal(app.sessions.get(sessionId)?.busy, false);
    });
  });
});

// ------------------------------------------------------------------------------------------------
// Errors
// ------------------------------------------------------------------------------------------------

describe("request errors", { timeout: 30_000 }, () => {
  let s: Started;
  before(async () => {
    s = await start();
  });
  after(async () => {
    await s.close();
  });

  it("unknown session -> 404 session_not_found", async () => {
    const res = await postRun(s.base, messageBody("0123456789abcdef0123456789abcdef", "make it for teens"));
    assert.equal(res.status, 404);
    assert.equal(res.error?.code, "session_not_found");
    const resolution = await postRun(s.base, { sessionId: "0123456789abcdef0123456789abcdef", input: { kind: "resolution", choices: [{ issueId: "c1.1", pick: null }] } });
    assert.equal(resolution.status, 404);
    assert.equal(resolution.error?.code, "session_not_found");
  });

  it("malformed session id and follow-up without a session -> 400 invalid_request", async () => {
    const bad = await postRun(s.base, messageBody("not-a-session", "hello there"));
    assert.equal(bad.status, 400);
    assert.equal(bad.error?.code, "invalid_request");
    const missing = await postRun(s.base, { input: { kind: "message", text: "hello there" } });
    assert.equal(missing.status, 400);
    assert.equal(missing.error?.code, "invalid_request");
  });

  it("invalid JSON -> 400 bad_json", async () => {
    for (const body of ["{nope", "", '{"input":', "not json at all"]) {
      const res = await postRun(s.base, body);
      assert.equal(res.status, 400, JSON.stringify(body));
      assert.equal(res.error?.code, "bad_json", JSON.stringify(body));
    }
  });

  it("wrong or missing content type -> 415", async () => {
    const form = (await samples(s.base))[0]!;
    for (const type of ["text/plain", "application/x-www-form-urlencoded", "multipart/form-data"]) {
      const res = await readRun(await fetch(`${s.base}/api/runs`, { method: "POST", headers: { "Content-Type": type }, body: JSON.stringify(formBody(form)) }));
      assert.equal(res.status, 415, type);
      assert.equal(res.error?.code, "unsupported_media_type", type);
    }
    // fetch labels a bare string body text/plain
    const bare = await readRun(await fetch(`${s.base}/api/runs`, { method: "POST", body: JSON.stringify(formBody(form)) }));
    assert.equal(bare.status, 415);
  });

  it("accepts application/json with a charset parameter, in any case", async () => {
    const form = (await samples(s.base))[0]!;
    for (const type of ["application/json; charset=utf-8", "Application/JSON"]) {
      const res = await readRun(await fetch(`${s.base}/api/runs`, { method: "POST", headers: { "Content-Type": type }, body: JSON.stringify(formBody(form)) }));
      assert.equal(res.status, 200, type);
      assert.equal(lastDone(res.events).reason, "completed");
    }
  });

  it("accepts a body just under the 32 KB limit", async () => {
    const form = (await samples(s.base))[0]!;
    const edge = JSON.stringify(formBody({ ...form, interests: "y".repeat(500) }));
    assert.ok(edge.length < 32 * 1024);
    assert.equal((await postRun(s.base, edge)).status, 200);
  });

  it("body over 32 KB -> 413 too_large, delivered to the client (not a connection reset)", async () => {
    const form = (await samples(s.base))[0]!;
    for (const size of [33 * 1024, 40_000, 200_000]) {
      const huge = JSON.stringify(formBody({ ...form, interests: "x".repeat(size) }));
      assert.ok(huge.length > 32 * 1024);
      let res: RunResponse;
      try {
        res = await postRun(s.base, huge);
      } catch (error) {
        const code = error instanceof Error ? String((error.cause as { code?: string } | undefined)?.code) : "?";
        assert.fail(`${size} bytes: the client got no HTTP response (${code}) instead of a 413`);
      }
      assert.equal(res.status, 413, `${size} bytes`);
      assert.equal(res.error?.code, "too_large", `${size} bytes`);
      assert.equal(res.events.length, 0);
    }
  });

  it("a refused oversized body does not wedge the server", async () => {
    const form = (await samples(s.base))[0]!;
    const huge = JSON.stringify(formBody({ ...form, interests: "x".repeat(60_000) }));
    assert.equal((await postRun(s.base, huge)).status, 413);
    const ok = await postRun(s.base, formBody(form));
    assert.equal(ok.status, 200);
    assert.equal(lastDone(ok.events).reason, "completed");
  });

  it("GET (and any other non-POST) /api/runs -> 405 method_not_allowed", async () => {
    for (const method of ["GET", "PUT", "DELETE", "PATCH", "OPTIONS"]) {
      const res = await readRun(await fetch(`${s.base}/api/runs`, { method }));
      assert.equal(res.status, 405, method);
      assert.equal(res.error?.code, "method_not_allowed", method);
    }
  });

  it("unknown /api path -> 404 JSON", async () => {
    for (const [method, path] of [["GET", "/api/nope"], ["POST", "/api/nope"], ["GET", "/api/"], ["GET", "/api/health/"], ["DELETE", "/api/runs/abc"]] as const) {
      const res = await fetch(`${s.base}${path}`, { method });
      assert.equal(res.status, 404, `${method} ${path}`);
      assert.match(res.headers.get("content-type") ?? "", /^application\/json/, `${method} ${path}`);
      assert.equal(((await res.json()) as ApiError).error.code, "not_found", `${method} ${path}`);
    }
  });

  it("rejects personal data in the form with 400 invalid_request", async () => {
    const form = (await samples(s.base))[0]!;
    const phone = await postRun(s.base, formBody({ ...form, interests: "Severance, call me on 973-555-0100" }));
    assert.equal(phone.status, 400);
    assert.equal(phone.error?.code, "invalid_request");
    assert.match(phone.error?.message ?? "", /email addresses and phone numbers/);
    const email = await postRun(s.base, formBody({ ...form, place: "pat@example.com" }));
    assert.equal(email.status, 400);
    assert.equal(email.error?.code, "invalid_request");
    assert.equal(only(email.events, "session").length, 0, "no run, no session");
  });

  it("rejects an invalid form or body shape with 400 invalid_request, before any run starts", async () => {
    const form = (await samples(s.base))[0]!;
    const sessionsBefore = s.app.sessions.size;
    const bodies: unknown[] = [null, [], "text", 42, {}, { input: {} }, formBody({ ...form, titleCount: 99 }), formBody({ ...form, ageBand: "elderly" }), formBody({ ...form, interests: "x" })];
    for (const body of bodies) {
      const res = await postRun(s.base, JSON.stringify(body));
      assert.equal(res.status, 400, JSON.stringify(body));
      assert.equal(res.error?.code, "invalid_request", JSON.stringify(body));
      assert.equal(typeof res.error?.message, "string");
    }
    assert.equal(s.app.sessions.size, sessionsBefore, "rejected requests must not leave sessions behind");
  });

  it("session busy -> 409 session_busy, and the first run is unaffected", async () => {
    await withApp({ latencyMs: 150 }, async ({ base, app }) => {
      const form = (await samples(base))[0]!;
      const run = await LiveRun.start(base, formBody(form));
      await run.waitFor((e) => e.type === "started");
      const sessionId = run.sessionId;
      assert.equal(app.sessions.get(sessionId)?.busy, true);

      const second = await postRun(base, messageBody(sessionId, "make it for teens"));
      assert.equal(second.status, 409);
      assert.equal(second.error?.code, "session_busy");
      const third = await postRun(base, { sessionId, input: { kind: "resolution", choices: [{ issueId: "c1.1", pick: null }] } });
      assert.equal(third.status, 409);

      const events = await run.finish();
      assert.equal(lastDone(events).reason, "completed");
      assert.equal(app.sessions.get(sessionId)?.busy, false);
      // and once it is idle the same session accepts the follow-up
      const ok = await postRun(base, messageBody(sessionId, "make it for teens"));
      assert.equal(ok.status, 200);
    });
  });
});

// ------------------------------------------------------------------------------------------------
// Rate limits
// ------------------------------------------------------------------------------------------------

describe("rate limits", { timeout: 30_000 }, () => {
  it("RATE_LIMIT_RUNS_PER_HOUR=2: the third form run is 429 with Retry-After and retryAfterSec", async () => {
    await withApp({ env: { RATE_LIMIT_RUNS_PER_HOUR: "2" } }, async ({ base, app }) => {
      const form = (await samples(base))[0]!;
      for (let i = 0; i < 2; i++) {
        const ok = await postRun(base, formBody(form));
        assert.equal(ok.status, 200, `run ${i + 1}`);
        assert.equal(lastDone(ok.events).reason, "completed");
      }
      const sessionsBefore = app.sessions.size;
      const limited = await postRun(base, formBody(form));
      assert.equal(limited.status, 429);
      assert.equal(limited.error?.code, "rate_limited");
      assert.match(limited.error?.message ?? "", /new runs per hour/);
      const retryAfter = limited.error?.retryAfterSec;
      assert.ok(typeof retryAfter === "number" && retryAfter >= 1 && retryAfter <= 3600, `retryAfterSec=${String(retryAfter)}`);
      assert.equal(limited.headers.get("retry-after"), String(retryAfter));
      assert.equal(limited.events.length, 0);
      assert.equal(app.sessions.size, sessionsBefore, "a limited request must not create a session");
    });
  });

  it("the window slides: a run is allowed again an hour later (injected clock)", async () => {
    let t = Date.now();
    await withApp({ env: { RATE_LIMIT_RUNS_PER_HOUR: "1" }, now: () => t }, async ({ base }) => {
      const form = (await samples(base))[0]!;
      assert.equal((await postRun(base, formBody(form))).status, 200);
      const limited = await postRun(base, formBody(form));
      assert.equal(limited.status, 429);
      assert.equal(limited.error?.retryAfterSec, 3600);
      t += 30 * 60_000;
      const half = await postRun(base, formBody(form));
      assert.equal(half.status, 429);
      assert.equal(half.error?.retryAfterSec, 1800);
      t += 30 * 60_000;
      assert.equal((await postRun(base, formBody(form))).status, 200);
    });
  });

  it("follow-up messages have their own limit (RATE_LIMIT_MESSAGES_PER_HOUR), separate from runs", async () => {
    await withApp({ env: { RATE_LIMIT_RUNS_PER_HOUR: "1", RATE_LIMIT_MESSAGES_PER_HOUR: "1" } }, async ({ base }) => {
      const form = (await samples(base))[0]!;
      const first = await postRun(base, formBody(form));
      assert.equal(first.status, 200);
      const sessionId = sessionOf(first.events);

      // runs are used up...
      const second = await postRun(base, formBody(form));
      assert.equal(second.status, 429);
      assert.match(second.error?.message ?? "", /new runs/);

      // ...but the message budget is untouched
      const m1 = await postRun(base, messageBody(sessionId, "make it for teens"));
      assert.equal(m1.status, 200);
      assert.equal(lastDone(m1.events).reason, "completed");

      const m2 = await postRun(base, messageBody(sessionId, "translated fiction please"));
      assert.equal(m2.status, 429);
      assert.equal(m2.error?.code, "rate_limited");
      assert.match(m2.error?.message ?? "", /message limit/);
      assert.ok((m2.error?.retryAfterSec ?? 0) >= 1);
      assert.equal(m2.headers.get("retry-after"), String(m2.error?.retryAfterSec));
    });
  });

  it("message limits do not consume the run budget", async () => {
    await withApp({ env: { RATE_LIMIT_RUNS_PER_HOUR: "2", RATE_LIMIT_MESSAGES_PER_HOUR: "1" } }, async ({ base }) => {
      const form = (await samples(base))[0]!;
      const first = await postRun(base, formBody(form));
      const sessionId = sessionOf(first.events);
      assert.equal((await postRun(base, messageBody(sessionId, "make it for teens"))).status, 200);
      assert.equal((await postRun(base, messageBody(sessionId, "translated fiction please"))).status, 429);
      assert.equal((await postRun(base, formBody(form))).status, 200, "the second form run is still within its own limit");
      assert.equal((await postRun(base, formBody(form))).status, 429);
    });
  });

  it("requests rejected before a run starts (bad body, unknown session) spend no run budget", async () => {
    await withApp({ env: { RATE_LIMIT_RUNS_PER_HOUR: "1" } }, async ({ base }) => {
      const form = (await samples(base))[0]!;
      assert.equal((await postRun(base, "{nope")).status, 400);
      assert.equal((await postRun(base, formBody({ ...form, titleCount: 99 }))).status, 400);
      assert.equal((await postRun(base, messageBody("0123456789abcdef0123456789abcdef", "hi there"))).status, 404);
      assert.equal((await postRun(base, formBody(form))).status, 200);
    });
  });
});

// ------------------------------------------------------------------------------------------------
// TRUST_PROXY
// ------------------------------------------------------------------------------------------------

describe("TRUST_PROXY and client identity", { timeout: 30_000 }, () => {
  const xff = (value: string): PostOptions => ({ headers: { "X-Forwarded-For": value } });

  it("with TRUST_PROXY=1 each forwarded client has its own limit", async () => {
    await withApp({ env: { TRUST_PROXY: "1", RATE_LIMIT_RUNS_PER_HOUR: "1" } }, async ({ base }) => {
      const form = formBody((await samples(base))[0]!);
      assert.equal((await postRun(base, form, xff("1.1.1.1"))).status, 200);
      assert.equal((await postRun(base, form, xff("2.2.2.2"))).status, 200);
      assert.equal((await postRun(base, form, xff("1.1.1.1"))).status, 429);
      assert.equal((await postRun(base, form, xff("2.2.2.2"))).status, 429);
      assert.equal((await postRun(base, form, xff("3.3.3.3"))).status, 200);
    });
  });

  it("with TRUST_PROXY=1 the proxy's (rightmost) entry decides, so a forged left entry cannot evade the limit", async () => {
    await withApp({ env: { TRUST_PROXY: "1", RATE_LIMIT_RUNS_PER_HOUR: "1" } }, async ({ base }) => {
      const form = formBody((await samples(base))[0]!);
      assert.equal((await postRun(base, form, xff("8.8.8.8, 3.3.3.3"))).status, 200);
      assert.equal((await postRun(base, form, xff("7.7.7.7, 3.3.3.3"))).status, 429);
      assert.equal((await postRun(base, form, xff("6.6.6.6, 4.4.4.4"))).status, 200);
    });
  });

  it("with TRUST_PROXY=1, CF-Connecting-IP wins over X-Forwarded-For", async () => {
    await withApp({ env: { TRUST_PROXY: "1", RATE_LIMIT_RUNS_PER_HOUR: "1" } }, async ({ base }) => {
      const form = formBody((await samples(base))[0]!);
      const as = (cf: string, forwarded: string): PostOptions => ({ headers: { "CF-Connecting-IP": cf, "X-Forwarded-For": forwarded } });
      assert.equal((await postRun(base, form, as("9.9.9.9", "1.1.1.1"))).status, 200);
      assert.equal((await postRun(base, form, as("9.9.9.9", "2.2.2.2"))).status, 429);
      assert.equal((await postRun(base, form, as("5.5.5.5", "1.1.1.1"))).status, 200);
    });
  });

  it("with TRUST_PROXY=2 the second entry from the right identifies the client", async () => {
    await withApp({ env: { TRUST_PROXY: "2", RATE_LIMIT_RUNS_PER_HOUR: "1" } }, async ({ base }) => {
      const form = formBody((await samples(base))[0]!);
      assert.equal((await postRun(base, form, xff("1.1.1.1, 10.0.0.1"))).status, 200);
      assert.equal((await postRun(base, form, xff("9.9.9.9, 1.1.1.1, 10.0.0.1"))).status, 429);
      assert.equal((await postRun(base, form, xff("9.9.9.9, 2.2.2.2, 10.0.0.1"))).status, 200);
    });
  });

  it("without TRUST_PROXY the forwarding headers are ignored: one socket address, one limit", async () => {
    await withApp({ env: { TRUST_PROXY: undefined, RATE_LIMIT_RUNS_PER_HOUR: "1" } }, async ({ base }) => {
      const form = formBody((await samples(base))[0]!);
      assert.equal((await postRun(base, form, xff("1.1.1.1"))).status, 200);
      assert.equal((await postRun(base, form, xff("2.2.2.2"))).status, 429);
      assert.equal((await postRun(base, form, { headers: { "CF-Connecting-IP": "3.3.3.3" } })).status, 429);
    });
  });

  it("TRUST_PROXY=0 behaves like unset", async () => {
    await withApp({ env: { TRUST_PROXY: "0", RATE_LIMIT_RUNS_PER_HOUR: "1" } }, async ({ base }) => {
      const form = formBody((await samples(base))[0]!);
      assert.equal((await postRun(base, form, xff("1.1.1.1"))).status, 200);
      assert.equal((await postRun(base, form, xff("2.2.2.2"))).status, 429);
    });
  });
});

// ------------------------------------------------------------------------------------------------
// Not configured: live mode never silently runs on sample data
// ------------------------------------------------------------------------------------------------

describe("live mode without keys", { timeout: 30_000 }, () => {
  it("refuses runs with 503 not_configured and never touches the Qloo client", async () => {
    const client = new CountingClient(0);
    await withApp({ demo: false, sample: false, client }, async ({ base }) => {
      const form: FormInput = { place: "Newark, NJ", ageBand: "any", interests: "Severance, The Bear", titleCount: 5 };
      const res = await postRun(base, formBody(form));
      assert.equal(res.status, 503);
      assert.equal(res.error?.code, "not_configured");
      assert.match(res.error?.message ?? "", /QLOO_API_KEY/);
      assert.match(res.error?.message ?? "", /NEBIUS_API_KEY/);
      assert.equal(res.events.length, 0, "no stream, no sample report");
      assert.doesNotMatch(res.raw, /Sample data/);

      // every kind of run request is refused the same way, even before the body is looked at
      const message = await postRun(base, messageBody("0123456789abcdef0123456789abcdef", "hello there"));
      assert.equal(message.status, 503);
      const junk = await postRun(base, "{nope");
      assert.equal(junk.status, 503);
      assert.equal(client.calls, 0);
    });
  });

  it("reports ready:false with the missing key in /api/health and offers no sample inputs", async () => {
    await withApp({ demo: false, sample: false }, async ({ base }) => {
      const { status, body } = await getJson<HealthResponse>(`${base}/api/health`);
      assert.equal(status, 200);
      assert.equal(body.mode, "live");
      assert.equal(body.ready, false);
      assert.ok(body.problems.some((p) => p.includes("QLOO_API_KEY")), body.problems.join("|"));
      assert.ok(body.problems.some((p) => p.includes("NEBIUS_API_KEY")), body.problems.join("|"));
      assert.deepEqual(body.sampleInputs, []);
      assert.equal(body.qloo.sample, false);
      const z = await getJson<Healthz>(`${base}/healthz`);
      assert.equal(z.body.mode, "live");
    });
  });

  it("names only the key that is still missing", async () => {
    await withApp({ demo: false, sample: false, env: { QLOO_API_KEY: "test-qloo-key" } }, async ({ base }) => {
      const res = await postRun(base, formBody({ place: "Newark, NJ", ageBand: "any", interests: "Severance", titleCount: 5 }));
      assert.equal(res.status, 503);
      assert.match(res.error?.message ?? "", /NEBIUS_API_KEY/);
      assert.doesNotMatch(res.error?.message ?? "", /QLOO_API_KEY is not set/);
      const { body } = await getJson<HealthResponse>(`${base}/api/health`);
      assert.equal(body.ready, false);
      assert.equal(body.problems.length, 1);
    });
  });

  it("is ready once both keys are set", async () => {
    await withApp({ demo: false, sample: false, env: { QLOO_API_KEY: "test-qloo-key", NEBIUS_API_KEY: "test-llm-key" } }, async ({ base }) => {
      const { body } = await getJson<HealthResponse>(`${base}/api/health`);
      assert.equal(body.ready, true);
      assert.deepEqual(body.problems, []);
      assert.equal(JSON.stringify(body).includes("test-qloo-key"), false, "health must never echo a key");
      assert.equal(JSON.stringify(body).includes("test-llm-key"), false, "health must never echo a key");
    });
  });

  it("a typo in an optional setting falls back to its default and does not stop runs", async () => {
    await withApp({ env: { MAX_QUEUE: "-3" } }, async ({ base }) => {
      const { body } = await getJson<HealthResponse>(`${base}/api/health`);
      assert.equal(body.ready, true);
      assert.deepEqual(body.problems, []);
      const res = await postRun(base, formBody((await samples(base))[0]!));
      assert.equal(res.status, 200);
    });
  });
});

// ------------------------------------------------------------------------------------------------
// Queue and client disconnects
// ------------------------------------------------------------------------------------------------

describe("run queue", { timeout: 30_000 }, () => {
  it("MAX_CONCURRENT_RUNS=1: the second run queues at position 1 before it starts, and both finish", async () => {
    await withApp({ latencyMs: 120, env: { MAX_CONCURRENT_RUNS: "1" } }, async ({ base, app }) => {
      const form = (await samples(base))[0]!;
      let peakRunning = 0;
      let peakWaiting = 0;
      const sampler = setInterval(() => {
        peakRunning = Math.max(peakRunning, app.queue.running);
        peakWaiting = Math.max(peakWaiting, app.queue.waiting);
      }, 5);
      try {
        const a = await LiveRun.start(base, formBody(form));
        await a.waitFor((e) => e.type === "started");
        const b = await LiveRun.start(base, formBody((await samples(base))[1]!));
        const [aEvents, bEvents] = await Promise.all([a.finish(), b.finish()]);

        assert.equal(lastDone(aEvents).reason, "completed");
        assert.equal(lastDone(bEvents).reason, "completed");
        assert.equal(only(aEvents, "queued").length, 0);

        const bTypes = types(bEvents);
        const queuedAt = bTypes.indexOf("queued");
        assert.ok(queuedAt >= 0, `B was never queued; saw ${bTypes.join(",")}`);
        assert.ok(queuedAt < bTypes.indexOf("started"), "queued must come before started");
        assert.ok(queuedAt > bTypes.indexOf("session"));
        assert.equal(bTypes.indexOf("started") < bTypes.indexOf("tool_call"), true);
        const q = only(bEvents, "queued")[0]!;
        assert.equal(q.position, 1);
        assert.equal(q.ahead, 0);
        assert.equal(only(bEvents, "queued").length, 1, "an unchanged position is not repeated");
        assert.ok(only(bEvents, "report").length === 1 && only(aEvents, "report").length === 1);
        assert.equal(peakRunning, 1, "never more than one run at a time");
        assert.equal(peakWaiting, 1);
      } finally {
        clearInterval(sampler);
      }
      assert.equal(app.queue.running, 0);
      assert.equal(app.queue.waiting, 0);
    });
  });

  it("with several waiters the positions are reported and move up as runs finish", async () => {
    await withApp({ latencyMs: 80, env: { MAX_CONCURRENT_RUNS: "1", MAX_QUEUE: "4" } }, async ({ base }) => {
      const all = await samples(base);
      const a = await LiveRun.start(base, formBody(all[0]!));
      await a.waitFor((e) => e.type === "started");
      const b = await LiveRun.start(base, formBody(all[1]!));
      await b.waitFor((e) => e.type === "queued");
      const c = await LiveRun.start(base, formBody(all[0]!));
      await c.waitFor((e) => e.type === "queued");
      const [aEvents, bEvents, cEvents] = await Promise.all([a.finish(), b.finish(), c.finish()]);
      for (const ev of [aEvents, bEvents, cEvents]) assert.equal(lastDone(ev).reason, "completed");
      assert.deepEqual(only(bEvents, "queued").map((q) => q.position), [1]);
      assert.deepEqual(only(cEvents, "queued").map((q) => q.position), [2, 1], "c waits behind b, then moves up when a finishes");
    });
  });

  it("MAX_QUEUE=0: a second concurrent run gets 503 busy with Retry-After, as plain JSON", async () => {
    await withApp({ latencyMs: 120, env: { MAX_CONCURRENT_RUNS: "1", MAX_QUEUE: "0" } }, async ({ base }) => {
      const form = formBody((await samples(base))[0]!);
      const a = await LiveRun.start(base, form);
      await a.waitFor((e) => e.type === "started");
      const b = await postRun(base, form);
      assert.equal(b.status, 503);
      assert.equal(b.error?.code, "busy");
      assert.equal(b.error?.retryAfterSec, 30);
      assert.equal(b.headers.get("retry-after"), "30");
      assert.equal(b.events.length, 0);
      assert.equal(lastDone(await a.finish()).reason, "completed");
      // once the first run is done there is room again
      assert.equal((await postRun(base, form)).status, 200);
    });
  });

  it("a 503 busy rejection does not spend a run-rate-limit hit", async () => {
    await withApp({ latencyMs: 120, env: { MAX_CONCURRENT_RUNS: "1", MAX_QUEUE: "0", RATE_LIMIT_RUNS_PER_HOUR: "2" } }, async ({ base }) => {
      const form = formBody((await samples(base))[0]!);
      const a = await LiveRun.start(base, form); // hit 1
      await a.waitFor((e) => e.type === "started");
      assert.equal((await postRun(base, form)).status, 503); // no hit
      await a.finish();
      assert.equal((await postRun(base, form)).status, 200); // hit 2
      assert.equal((await postRun(base, form)).status, 429);
    });
  });

  it("a client that disconnects mid-stream frees its slot, and the next run still works", async () => {
    await withApp({ latencyMs: 150 }, async ({ base, app }) => {
      const form = formBody((await samples(base))[0]!);
      const run = await LiveRun.start(base, form);
      await run.waitFor((e) => e.type === "started");
      const sessionId = run.sessionId;
      assert.equal(app.queue.running, 1);

      run.abort();
      await waitUntil(() => app.queue.running === 0);
      await waitUntil(() => app.sessions.get(sessionId)?.busy === false);
      assert.equal(app.queue.waiting, 0);

      const next = await postRun(base, form);
      assert.equal(next.status, 200);
      assert.equal(lastDone(next.events).reason, "completed");
      assert.equal(app.queue.running, 0);
    });
  });

  it("a queued client that disconnects leaves the queue without disturbing the run ahead", async () => {
    await withApp({ latencyMs: 120, env: { MAX_CONCURRENT_RUNS: "1", MAX_QUEUE: "3" } }, async ({ base, app }) => {
      const all = await samples(base);
      const a = await LiveRun.start(base, formBody(all[0]!));
      await a.waitFor((e) => e.type === "started");
      const b = await LiveRun.start(base, formBody(all[1]!));
      await b.waitFor((e) => e.type === "queued");
      assert.equal(app.queue.waiting, 1);

      b.abort();
      await waitUntil(() => app.queue.waiting === 0);
      const aEvents = await a.finish();
      assert.equal(lastDone(aEvents).reason, "completed");
      assert.equal(only(aEvents, "error").length, 0);
      await waitUntil(() => app.queue.running === 0);
    });
  });

  it("closing the app while a run is streaming aborts it cleanly", async () => {
    const s = await start({ latencyMs: 150 });
    const run = await LiveRun.start(s.base, formBody((await samples(s.base))[0]!));
    await run.waitFor((e) => e.type === "started");
    await s.close();
    assert.equal(s.app.queue.running, 0);
    const events = await run.finish();
    assert.notEqual(types(events).at(-1), "report");
  });
});

// ------------------------------------------------------------------------------------------------
// Static files
// ------------------------------------------------------------------------------------------------

describe("static files", { timeout: 30_000 }, () => {
  const INDEX = "<!doctype html><title>Shelfwise test</title><div id=root>shelfwise-index</div>";
  const JS = "console.log('shelfwise-test-asset');";
  let root: string;
  let site: string;
  let s: Started;

  before(async () => {
    root = mkdtempSync(join(tmpdir(), "shelfwise-static-"));
    site = join(root, "site");
    mkdirSync(join(site, "assets"), { recursive: true });
    writeFileSync(join(site, "index.html"), INDEX);
    writeFileSync(join(site, "assets", "app.js"), JS);
    writeFileSync(join(site, "assets", "app.css"), "body{}");
    writeFileSync(join(site, "favicon.svg"), "<svg xmlns='http://www.w3.org/2000/svg'/>");
    // a sibling directory whose name starts with the web root's name, and a file outside the root altogether
    mkdirSync(join(root, "site-secret"), { recursive: true });
    writeFileSync(join(root, "site-secret", "secret.txt"), "TOP-SECRET");
    writeFileSync(join(root, "outside.txt"), "OUTSIDE");
    s = await start({ webRoot: site });
  });

  after(async () => {
    await s.close();
    rmSync(root, { recursive: true, force: true });
  });

  /** A raw request, so the path reaches the server exactly as written (fetch would normalise "/../"). */
  const raw = (path: string, method = "GET"): Promise<{ status: number; body: string; headers: Record<string, string | string[] | undefined> }> =>
    new Promise((resolve, reject) => {
      const { port } = s.app.server.address() as AddressInfo;
      const req = httpRequest({ host: "127.0.0.1", port, path, method }, (res) => {
        let body = "";
        res.setEncoding("utf8");
        res.on("data", (c: string) => (body += c));
        res.on("end", () => resolve({ status: res.statusCode ?? 0, body, headers: res.headers }));
      });
      req.on("error", reject);
      req.end();
    });

  it("GET / serves index.html with no-cache", async () => {
    const res = await fetch(`${s.base}/`);
    assert.equal(res.status, 200);
    assert.match(res.headers.get("content-type") ?? "", /^text\/html/);
    assert.equal(res.headers.get("cache-control"), "no-cache");
    assert.equal(await res.text(), INDEX);
    SECURITY_HEADERS(res, "static /");
  });

  it("serves index.html for client-side routes (no file extension)", async () => {
    for (const path of ["/some/spa/route", "/report", "/a/b/c/d", "/assets"]) {
      const res = await fetch(`${s.base}${path}`);
      assert.equal(res.status, 200, path);
      assert.match(res.headers.get("content-type") ?? "", /^text\/html/, path);
      assert.equal(await res.text(), INDEX, path);
    }
    assert.equal((await fetch(`${s.base}/index.html`)).status, 200);
  });

  it("serves assets with the right type and an immutable one-year Cache-Control", async () => {
    const js = await fetch(`${s.base}/assets/app.js`);
    assert.equal(js.status, 200);
    assert.match(js.headers.get("content-type") ?? "", /^text\/javascript/);
    assert.match(js.headers.get("cache-control") ?? "", /immutable/);
    assert.match(js.headers.get("cache-control") ?? "", /max-age=31536000/);
    assert.equal(js.headers.get("content-length"), String(Buffer.byteLength(JS)));
    assert.equal(await js.text(), JS);

    const css = await fetch(`${s.base}/assets/app.css`);
    assert.match(css.headers.get("content-type") ?? "", /^text\/css/);
    assert.match(css.headers.get("cache-control") ?? "", /immutable/);
    await css.text();

    // files outside /assets/ are revalidated, not frozen
    const icon = await fetch(`${s.base}/favicon.svg`);
    assert.equal(icon.status, 200);
    assert.equal(icon.headers.get("content-type"), "image/svg+xml");
    assert.equal(icon.headers.get("cache-control"), "no-cache");
    await icon.text();
  });

  it("a missing asset is a 404, not the SPA page", async () => {
    for (const path of ["/assets/missing.js", "/missing.css", "/assets/app.js.map", "/nope/page.html"]) {
      const res = await fetch(`${s.base}${path}`);
      assert.equal(res.status, 404, path);
      assert.match(res.headers.get("content-type") ?? "", /^text\/plain/, path);
      assert.doesNotMatch(await res.text(), /shelfwise-index/, path);
    }
  });

  it("does not let a path escape the web root", async () => {
    const attempts = [
      "/..%2f..%2fetc/passwd",
      "/..%2foutside.txt",
      "/%2e%2e/outside.txt",
      "/..%2fsite-secret%2fsecret.txt",
      "/assets/..%2f..%2foutside.txt",
      "/assets/%2e%2e%2f%2e%2e%2foutside.txt",
      "/..%5coutside.txt",
    ];
    for (const path of attempts) {
      const res = await raw(path);
      assert.equal(res.status, 404, path);
      assert.doesNotMatch(res.body, /OUTSIDE|TOP-SECRET|root:/, path);
    }
    // literal dot segments never reach the server through a normalising client, but a raw client can send them
    for (const path of ["/../outside.txt", "/../../etc/passwd", "/assets/../../outside.txt", "/../site-secret/secret.txt"]) {
      const res = await raw(path);
      assert.doesNotMatch(res.body, /OUTSIDE|TOP-SECRET|root:/, path);
      assert.ok(res.status === 404 || res.status === 200, `${path}: ${res.status}`);
      if (res.status === 200) assert.equal(res.body, INDEX, `${path} may only ever serve the SPA page`);
    }
  });

  it("answers odd paths with a 404, never a 500", async () => {
    for (const path of ["/%00", "/%E0%A4%A", "/assets/%00.js", "/%"]) {
      const res = await raw(path);
      assert.equal(res.status, 404, path);
    }
  });

  it("HEAD / returns the headers without a body", async () => {
    const res = await fetch(`${s.base}/`, { method: "HEAD" });
    assert.equal(res.status, 200);
    assert.match(res.headers.get("content-type") ?? "", /^text\/html/);
    assert.equal(res.headers.get("content-length"), String(Buffer.byteLength(INDEX)));
    assert.equal(await res.text(), "");
    const asset = await fetch(`${s.base}/assets/app.js`, { method: "HEAD" });
    assert.equal(asset.status, 200);
    assert.equal(await asset.text(), "");
  });

  it("only GET and HEAD are served outside /api", async () => {
    for (const method of ["POST", "PUT", "DELETE"]) {
      const res = await fetch(`${s.base}/`, { method });
      assert.equal(res.status, 405, method);
      await res.text();
    }
  });

  it("never lets the SPA fallback shadow the API", async () => {
    const res = await fetch(`${s.base}/api/whatever`);
    assert.equal(res.status, 404);
    assert.match(res.headers.get("content-type") ?? "", /^application\/json/);
    const health = await fetch(`${s.base}/api/health`);
    assert.match(health.headers.get("content-type") ?? "", /^application\/json/);
    await health.text();
    const hz = await fetch(`${s.base}/healthz`);
    assert.match(hz.headers.get("content-type") ?? "", /^application\/json/);
    await hz.text();
  });

  it("without a webRoot, GET / is a plain-text 404", async () => {
    await withApp({}, async ({ base }) => {
      const res = await fetch(`${base}/`);
      assert.equal(res.status, 404);
      assert.match(res.headers.get("content-type") ?? "", /^text\/plain/);
      assert.match(await res.text(), /Shelfwise API is running/);
      const other = await fetch(`${base}/assets/app.js`);
      assert.equal(other.status, 404);
      assert.equal(await other.text(), "Not found");
      const spa = await fetch(`${base}/some/route`);
      assert.equal(spa.status, 404);
      await spa.text();
    });
  });

  it("a webRoot that does not exist is the same as no webRoot", async () => {
    await withApp({ webRoot: join(root, "does-not-exist") }, async ({ base }) => {
      const res = await fetch(`${base}/`);
      assert.equal(res.status, 404);
      await res.text();
      const asset = await fetch(`${base}/assets/app.js`);
      assert.equal(asset.status, 404);
      await asset.text();
    });
  });

  it("judges 'hashed asset' by the path inside the web root, so a web root under an /assets/ directory keeps index.html revalidating", async () => {
    const odd = join(root, "assets", "site");
    mkdirSync(join(odd, "assets"), { recursive: true });
    writeFileSync(join(odd, "index.html"), INDEX);
    writeFileSync(join(odd, "assets", "app.js"), JS);
    writeFileSync(join(odd, "favicon.svg"), "<svg xmlns='http://www.w3.org/2000/svg'/>");
    await withApp({ webRoot: odd }, async ({ base }) => {
      const index = await fetch(`${base}/`);
      assert.equal(index.status, 200);
      assert.equal(index.headers.get("cache-control"), "no-cache");
      await index.text();
      const icon = await fetch(`${base}/favicon.svg`);
      assert.equal(icon.headers.get("cache-control"), "no-cache");
      await icon.text();
      const asset = await fetch(`${base}/assets/app.js`);
      assert.equal(asset.status, 200);
      assert.match(asset.headers.get("cache-control") ?? "", /immutable/);
      await asset.text();
    });
  });
});

// ------------------------------------------------------------------------------------------------
// Which planner runs, and what it is allowed to reach
// ------------------------------------------------------------------------------------------------

describe("planner selection and key handling", { timeout: 60_000 }, () => {
  it("sample mode with no NEBIUS_API_KEY uses the scripted planner and /api/health says so", async () => {
    const config = loadConfig({ DEMO_FIXTURES: "1" });
    await withApp({ llm: createLlm(config, true) }, async ({ base }) => {
      const { body } = await getJson<HealthResponse>(`${base}/api/health`);
      assert.equal(body.llm.scripted, true);
      assert.equal(body.mode, "fixtures");
    });
  });

  it("sample mode with NEBIUS_API_KEY uses the real model client, and /api/health says so without echoing the key", async () => {
    const env = { DEMO_FIXTURES: "1", NEBIUS_API_KEY: "dummy-key-that-must-not-appear", SHELFWISE_LLM_BASE_URL: "http://127.0.0.1:9/v1/" };
    const config = loadConfig(env);
    await withApp({ env, llm: createLlm(config, true) }, async ({ base }) => {
      const { body } = await getJson<HealthResponse>(`${base}/api/health`);
      assert.equal(body.llm.scripted, false);
      assert.equal(body.llm.provider, "openai-compatible");
      assert.equal(body.llm.model, config.llm.model);
      assert.equal(body.mode, "fixtures", "the Qloo data is still sample data");
      assert.equal(JSON.stringify(body).includes("dummy-key-that-must-not-appear"), false);
    });
  });

  /** A local stand-in for a model endpoint that records what reaches it. */
  async function tripwire(): Promise<{ url: string; hits: { line: string; bearer: string | undefined }[]; close(): Promise<void> }> {
    const hits: { line: string; bearer: string | undefined }[] = [];
    const server = createServer((req, res) => {
      hits.push({ line: `${req.method} ${req.url}`, bearer: req.headers.authorization });
      res.statusCode = 401;
      res.setHeader("Content-Type", "application/json");
      res.end("{}");
    });
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
    const port = (server.address() as AddressInfo).port;
    return { url: `http://127.0.0.1:${port}/v1/`, hits, close: () => new Promise<void>((r) => (server.closeAllConnections(), server.close(() => r()))) };
  }

  it("with only other tools' variables in the environment, a full sample run makes no outbound model request", async () => {
    const trap = await tripwire();
    const realFetch = globalThis.fetch;
    const hosts: string[] = [];
    globalThis.fetch = ((input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => {
      const u = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
      hosts.push(new URL(u).host);
      return realFetch(input, init);
    }) as typeof fetch;
    try {
      const env = { DEMO_FIXTURES: "1", LLM_API_KEY: "another-tools-key", OPENAI_API_KEY: "another-tools-openai-key", LLM_BASE_URL: trap.url, LLM_MODEL: "another-tools-model" };
      const config = loadConfig(env);
      const llm = createLlm(config, true);
      assert.equal(llm.scripted, true, "foreign variables must not select the real client");
      await withApp({ env, llm }, async ({ base }) => {
        const health = await getJson<HealthResponse>(`${base}/api/health`);
        assert.equal(health.body.llm.scripted, true);
        const res = await postRun(base, formBody((await samples(base))[0]!));
        assert.equal(res.status, 200);
        assert.equal(res.events.at(-1)?.type, "done");
        assert.ok(res.events.some((e) => e.type === "report"), "the run produced a report");
        assert.ok(!res.events.some((e) => e.type === "error"), "and no error (a 401 from a model would show as one)");
      });
      assert.deepEqual(trap.hits, [], "nothing reached the endpoint named by LLM_BASE_URL");
      assert.ok(hosts.length > 0 && new Set(hosts).size === 1, `only the app itself was contacted by fetch(): ${[...new Set(hosts)].join(", ")}`);
    } finally {
      globalThis.fetch = realFetch;
      await trap.close();
    }
  });

  it("control: with NEBIUS_API_KEY the same run does reach the configured model endpoint, carrying only that key", async () => {
    const trap = await tripwire();
    try {
      const env = { DEMO_FIXTURES: "1", NEBIUS_API_KEY: "ours-for-the-model", LLM_API_KEY: "another-tools-key", SHELFWISE_LLM_BASE_URL: trap.url };
      const config = loadConfig(env);
      const llm = createLlm(config, true);
      assert.equal(llm.scripted, false);
      await withApp({ env: { ...env, AGENT_MAX_RETRIES: "0" }, llm }, async ({ base }) => {
        const res = await postRun(base, formBody((await samples(base))[0]!));
        assert.equal(res.status, 200);
        assert.ok(res.events.some((e) => e.type === "error"), "the stand-in answers 401, so the run reports a model error rather than faking a report");
        assert.ok(!res.events.some((e) => e.type === "report"));
      });
      assert.ok(trap.hits.length >= 1, "the model endpoint was contacted");
      assert.ok(trap.hits.every((h) => h.line === "POST /v1/chat/completions"));
      assert.ok(trap.hits.every((h) => h.bearer === "Bearer ours-for-the-model"), "only NEBIUS_API_KEY was sent");
    } finally {
      await trap.close();
    }
  });
});
