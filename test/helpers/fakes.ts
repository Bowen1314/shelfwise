import { mkdtempSync, readFileSync, existsSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import type { AgentLimits } from "../../src/agent/loop.js";
import { type ChatMessage, type ChatRequest, type ChatResponse, type LlmClient, LlmError, type ToolCall } from "../../src/agent/llm.js";
import { TtlCache } from "../../src/qloo/cache.js";
import { McpQlooClient } from "../../src/qloo/mcp-client.js";
import { QlooService } from "../../src/qloo/service.js";
import type { QlooEnvelope } from "../../src/qloo/types.js";
import type { AgentEvent, FormInput } from "../../src/shared/types.js";

export const FAKE_SERVER = fileURLToPath(new URL("./fake-qloo-server.mjs", import.meta.url));

export const FORM: FormInput = { place: "Newark, NJ", ageBand: "any", interests: "Severance, The Bear", titleCount: 5 };

export const LIMITS: AgentLimits = { maxSteps: 12, maxToolCalls: 20, maxRetries: 2, retryBaseMs: 0, maxSessionToolCalls: 60, maxReportRepairs: 2 };

export interface FakeMcp {
  client: McpQlooClient;
  service: QlooService;
  /** Every tools/call the fake server actually received (after caching and budget checks). */
  realCalls(): { tool: string; args: Record<string, unknown> }[];
  dispose(): Promise<void>;
}

export interface FakeMcpOptions {
  env?: Record<string, string>;
  dailyCallBudget?: number;
  timeoutMs?: number;
  concurrency?: number;
  now?: () => number;
}

/** A real McpQlooClient talking to the fake stdio MCP server in a child process. */
export function startFakeMcp(opts: FakeMcpOptions = {}): FakeMcp {
  const dir = mkdtempSync(join(tmpdir(), "shelfwise-test-"));
  const log = join(dir, "calls.jsonl");
  const env: NodeJS.ProcessEnv = { PATH: process.env["PATH"] ?? "", FAKE_QLOO_LOG: log, FAKE_QLOO_CRASH_MARKER: join(dir, "crash.marker"), ...(opts.env ?? {}) };
  const client = new McpQlooClient({ command: process.execPath, args: [FAKE_SERVER] }, env);
  const service = new QlooService({
    client,
    cache: new TtlCache<QlooEnvelope>(60_000, 100),
    dailyCallBudget: opts.dailyCallBudget ?? 1000,
    timeoutMs: opts.timeoutMs ?? 10_000,
    concurrency: opts.concurrency ?? 3,
    ...(opts.now ? { now: opts.now } : {}),
  });
  return {
    client,
    service,
    realCalls: () => (existsSync(log) ? readFileSync(log, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l) as { tool: string; args: Record<string, unknown> }) : []),
    async dispose() {
      await client.close();
      rmSync(dir, { recursive: true, force: true });
    },
  };
}

// ---------------------------------------------------------------------------------------------
// A scripted language model: each step is a function of the request, consumed in order.
// ---------------------------------------------------------------------------------------------

export type LlmStep = (req: ChatRequest, step: number) => ChatResponse | Promise<ChatResponse>;

export class ScriptLlm implements LlmClient {
  readonly provider = "test-script";
  readonly model = "test-script";
  readonly scripted = true;
  readonly requests: ChatRequest[] = [];
  private i = 0;
  constructor(private readonly steps: LlmStep[], private readonly onExhausted?: LlmStep) {}

  get calls(): number {
    return this.i;
  }

  async chat(req: ChatRequest): Promise<ChatResponse> {
    this.requests.push({ ...req, messages: [...req.messages] });
    const step = this.steps[this.i] ?? this.onExhausted;
    this.i += 1;
    if (!step) throw new Error(`ScriptLlm ran out of steps at call ${this.i}`);
    return step(req, this.i - 1);
  }
}

let counter = 0;
export const toolCall = (name: string, args: unknown): ToolCall => ({ id: `tc${++counter}`, type: "function", function: { name, arguments: typeof args === "string" ? args : JSON.stringify(args) } });
export const calls = (...c: ToolCall[]): ChatResponse => ({ content: "", toolCalls: c });
export const say = (text: string): ChatResponse => ({ content: text, toolCalls: [] });

export const PLAN = toolCall("set_plan", { steps: [{ title: "Find books for each thing patrons love", tool: "qloo_recommend" }, { title: "Rank the shortlist", tool: "qloo_rank" }] });

/** Every {ref, name} pair that appears in the tool results the model has been shown so far. */
export function refsSeen(messages: ChatMessage[]): Map<string, string> {
  const byName = new Map<string, string>();
  const walk = (v: unknown): void => {
    if (Array.isArray(v)) return v.forEach(walk);
    if (v && typeof v === "object") {
      const o = v as Record<string, unknown>;
      if (typeof o["ref"] === "string" && typeof o["name"] === "string" && !byName.has(o["name"])) byName.set(o["name"], o["ref"]);
      Object.values(o).forEach(walk);
    }
  };
  for (const m of messages) {
    if (m.role !== "tool") continue;
    try {
      walk(JSON.parse(m.content));
    } catch {
      /* not JSON */
    }
  }
  return byName;
}

export function ref(req: ChatRequest, name: string): string {
  const r = refsSeen(req.messages).get(name);
  if (!r) throw new Error(`no ref for "${name}" in tool results; saw: ${[...refsSeen(req.messages).keys()].join(", ")}`);
  return r;
}

export const lastToolText = (req: ChatRequest): string => {
  for (let i = req.messages.length - 1; i >= 0; i--) {
    const m = req.messages[i]!;
    if (m.role === "tool") return m.content;
  }
  return "";
};

export const transientLlmError = (): never => {
  throw new LlmError("overloaded", true, 503);
};

// ---------------------------------------------------------------------------------------------

export interface Collected {
  events: AgentEvent[];
  emit: (e: AgentEvent) => void;
  of<T extends AgentEvent["type"]>(type: T): Extract<AgentEvent, { type: T }>[];
  last<T extends AgentEvent["type"]>(type: T): Extract<AgentEvent, { type: T }> | undefined;
}

export function collect(): Collected {
  const events: AgentEvent[] = [];
  return {
    events,
    emit: (e) => events.push(e),
    of: <T extends AgentEvent["type"]>(type: T) => events.filter((e): e is Extract<AgentEvent, { type: T }> => e.type === type),
    last: <T extends AgentEvent["type"]>(type: T) => events.filter((e): e is Extract<AgentEvent, { type: T }> => e.type === type).at(-1),
  };
}

/** Every string value in a JSON-like structure. */
export function allStrings(v: unknown, out: string[] = []): string[] {
  if (typeof v === "string") out.push(v);
  else if (Array.isArray(v)) v.forEach((x) => allStrings(x, out));
  else if (v && typeof v === "object") Object.values(v).forEach((x) => allStrings(x, out));
  return out;
}
