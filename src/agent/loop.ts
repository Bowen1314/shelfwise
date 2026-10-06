import type { AgentEvent, DoneReason, PlanStep, ResolutionChoice, ResolutionIssue } from "../shared/types.js";
import type { JsonObject, QlooEnvelope, ToolDef } from "../qloo/types.js";
import type { QlooService } from "../qloo/service.js";
import { stripHarmlessArgs, validateToolArgs } from "../qloo/validate.js";
import { digestFor, labelFor } from "./evidence.js";
import { type GuardContext, checkSubmission, extractJsonObject } from "./guard.js";
import { type ChatMessage, type ChatResponse, type LlmClient, LlmError, type ToolCall, type ToolChoice, type ToolSpec } from "./llm.js";
import { formMessage, systemPrompt } from "./prompt.js";
import type { Session } from "./session.js";
import { LOCAL_TOOLS, SET_PLAN, SUBMIT_REPORT, buildToolSpecs } from "./tools.js";

export interface AgentLimits {
  /** Max language-model turns per request. */
  maxSteps: number;
  /** Max tool calls (Qloo calls, including invalid ones) per request. */
  maxToolCalls: number;
  /** Bounded retries for retryable failures (Qloo `error.retryable`, transient LLM errors). */
  maxRetries: number;
  retryBaseMs: number;
  /** Max tool calls over a whole session (follow-ups included). */
  maxSessionToolCalls: number;
  /** Extra submit_report attempts after a guard rejection. */
  maxReportRepairs: number;
}

export interface AgentDeps {
  llm: LlmClient;
  qloo: QlooService;
  limits: AgentLimits;
  /** True when Qloo data is placeholder fixtures. */
  sample: boolean;
  now?: () => Date;
  sleep?: (ms: number, signal: AbortSignal) => Promise<void>;
}

export type UserTurn =
  | { kind: "form" }
  | { kind: "message"; text: string }
  | { kind: "resolution"; choices: ResolutionChoice[] };

/** Failures that make further Qloo calls pointless in this request. */
const FATAL_CODES = new Set(["QLOO_AUTH", "DEMO_BUDGET_EXHAUSTED", "QLOO_MCP_START_FAILED"]);

const defaultSleep = (ms: number, signal: AbortSignal): Promise<void> =>
  new Promise((resolve) => {
    if (signal.aborted || ms <= 0) return resolve();
    const t = setTimeout(resolve, ms);
    signal.addEventListener("abort", () => (clearTimeout(t), resolve()), { once: true });
  });

interface ToolOutcome {
  content: string;
  issues?: ResolutionIssue[];
  fatal?: { code: string; message: string };
  reportPublished?: boolean;
}

function resolutionMessage(session: Session, choices: ResolutionChoice[]): string {
  const lines: string[] = [];
  const answered = new Set<string>();
  for (const c of choices) {
    const issue = session.pending.get(c.issueId);
    if (!issue || answered.has(c.issueId)) continue;
    answered.add(c.issueId);
    if (c.pick === null) {
      lines.push(`- "${issue.input}" (from ${issue.tool}, argument ${issue.field}): the user chose to skip it. Do not use it.`);
      continue;
    }
    const cand = issue.candidates.find((x) => x.id === c.pick?.id);
    if (!cand) continue;
    const kind = issue.inputKind === "tag" ? "tag id" : "entity id";
    lines.push(`- "${issue.input}" (argument ${issue.field}): the user confirmed ${cand.name}${cand.type ? ` [${cand.type}]` : ""}${cand.releaseYear ? ` (${cand.releaseYear})` : ""}. Use this Qloo ${kind}: ${cand.id}`);
  }
  for (const issue of session.pending.values()) {
    if (!answered.has(issue.issueId)) lines.push(`- "${issue.input}": no answer given; treat it as skipped.`);
  }
  return ["The user answered the clarification questions:", ...lines, "Continue the work: repeat only the calls that needed these answers, passing the ids exactly, then continue the plan."].join("\n");
}

/** Keep the model's context bounded: elide old tool results (entities stay addressable by ref). */
function compactHistory(messages: ChatMessage[]): void {
  const total = messages.reduce((n, m) => n + (typeof m.content === "string" ? m.content.length : 0), 0);
  if (total < 150_000) return;
  const keepFrom = Math.max(0, messages.length - 14);
  for (let i = 0; i < keepFrom; i++) {
    const m = messages[i]!;
    if (m.role === "tool" && m.content.length > 400) {
      messages[i] = { role: "tool", tool_call_id: m.tool_call_id, content: '{"note":"older result elided to save space; its entities remain available by ref"}' };
    }
  }
}

function parseArgs(text: string): JsonObject | undefined {
  const v = text.trim() === "" ? {} : extractJsonObject(text);
  return v !== null && typeof v === "object" && !Array.isArray(v) ? (v as JsonObject) : undefined;
}

export async function runAgent(
  deps: AgentDeps,
  session: Session,
  turn: UserTurn,
  emit: (e: AgentEvent) => void,
  signal: AbortSignal,
): Promise<DoneReason> {
  const { llm, qloo, limits } = deps;
  const now = deps.now ?? (() => new Date());
  const sleep = deps.sleep ?? defaultSleep;
  const today = now().toISOString().slice(0, 10);
  let steps = 0;
  let toolCalls = 0;
  let reportAttempts = 0;
  let nudged = false;

  const finish = (reason: DoneReason): DoneReason => {
    emit({ type: "done", reason, steps, toolCalls });
    return reason;
  };

  try {
    // ---- the user's turn
    if (turn.kind === "form") {
      session.messages.push({ role: "user", content: formMessage(session.form, today) });
    } else if (turn.kind === "message") {
      session.followUps += 1;
      session.messages.push({ role: "user", content: turn.text });
    } else {
      for (const c of turn.choices) {
        const cand = c.pick ? session.pending.get(c.issueId)?.candidates.find((x) => x.id === c.pick?.id) : undefined;
        if (cand) session.store.rememberName(cand.id, cand.name);
      }
      session.messages.push({ role: "user", content: resolutionMessage(session, turn.choices) });
      session.pending.clear();
    }

    let qlooTools: ToolDef[];
    try {
      qlooTools = await qloo.tools();
    } catch (error) {
      emit({ type: "error", code: "QLOO_UNAVAILABLE", message: `Could not reach the Qloo tool server: ${error instanceof Error ? error.message : String(error)}`, retryable: true });
      return finish("error");
    }
    const specs = buildToolSpecs(qlooTools);
    const system: ChatMessage = { role: "system", content: systemPrompt({ today, maxToolCalls: limits.maxToolCalls }) };
    const toolsByName = new Map(qlooTools.map((t) => [t.name, t]));

    const budgetUsed = (): boolean => toolCalls >= limits.maxToolCalls || session.toolCallsTotal >= limits.maxSessionToolCalls;

    // ---- chat with bounded retries
    const chat = async (tools: ToolSpec[], toolChoice?: ToolChoice): Promise<ChatResponse> => {
      for (let attempt = 0; ; attempt++) {
        try {
          return await llm.chat({ messages: [system, ...session.messages], tools, ...(toolChoice ? { toolChoice } : {}), signal });
        } catch (error) {
          if (error instanceof LlmError && error.retryable && attempt < limits.maxRetries && !signal.aborted) {
            const delay = error.retryAfterMs ?? limits.retryBaseMs * 2 ** attempt;
            emit({ type: "note", text: `The language model was busy; retrying (attempt ${attempt + 2}).` });
            await sleep(delay, signal);
            continue;
          }
          throw error;
        }
      }
    };

    // ---- publishing a report
    const processSubmission = (raw: unknown): { content: string; published: boolean } => {
      const ctx: GuardContext = {
        store: session.store,
        form: session.form,
        userText: `${session.form.place} ${session.form.interests} ${turn.kind === "message" ? turn.text : ""}`,
        sample: deps.sample,
        version: session.reportVersion + 1,
        now: now(),
      };
      const result = checkSubmission(raw, ctx);
      reportAttempts += 1;
      const clean = result.complete && result.problems.length === 0;
      const lastChance = reportAttempts > limits.maxReportRepairs;
      const anything = result.report.bridgeShelf.length + result.report.buyList.length + result.report.programmes.length > 0;
      if (clean || (lastChance && anything)) {
        session.reportVersion += 1;
        session.lastReport = result.report;
        session.unreportedCalls = 0;
        emit({ type: "report", report: result.report });
        return { content: JSON.stringify({ ok: true, published: true, withheld: result.withheld }), published: true };
      }
      if (lastChance) {
        return { content: JSON.stringify({ ok: false, problems: result.problems.slice(0, 12), note: "Out of repair attempts." }), published: false };
      }
      return { content: JSON.stringify({ ok: false, problems: result.problems.slice(0, 12), instruction: "Fix every problem and call submit_report again with the complete report." }), published: false };
    };

    // ---- executing one Qloo tool call
    const execQloo = async (call: ToolCall, callId: string, tool: ToolDef, args: JsonObject): Promise<ToolOutcome> => {
      const store = session.store;
      const failure = (code: string, summary: string, recovery: string): QlooEnvelope => ({
        schema_version: "1.0-preview.1",
        operation: tool.name.replace(/^qloo_/, ""),
        status: "error",
        summary,
        results: [],
        result_count: 0,
        error: { code, layer: "shelfwise", retryable: false, recovery },
      });

      const expanded = store.expandHandles(args);
      const stripped = stripHarmlessArgs(tool, expanded.args);
      const callArgs = stripped.args;
      const notes: string[] = stripped.dropped.map((k) => `Ignored argument "${k}": ${tool.name} does not take it.`);
      let problem: string | undefined;
      if (expanded.unknown.length) problem = `Unknown ref(s) ${expanded.unknown.join(", ")}: refs must come from tool results in this conversation.`;
      const validation = problem ? { ok: false, errors: [problem] } : validateToolArgs(tool, callArgs);
      emit({ type: "tool_call", call: { callId, tool: tool.name, args: callArgs, label: labelFor(tool.name, callArgs, store) } });

      if (!validation.ok) {
        const env = failure("INVALID_ARGUMENTS", `The arguments were rejected before calling Qloo: ${validation.errors.join("; ")}`, "Fix the arguments to match the tool schema and try again.");
        const rec = store.addCall({ callId, tool: tool.name, args: callArgs, envelope: env, durationMs: 0, cached: false, sample: deps.sample });
        emit({ type: "tool_result", result: rec.view });
        return { content: digestFor(rec, notes) };
      }

      let result = await qloo.call(tool.name, callArgs, signal);
      for (let attempt = 0; attempt < limits.maxRetries; attempt++) {
        const err = result.envelope.error;
        if (result.envelope.status !== "error" || !err?.retryable || signal.aborted) break;
        const delay = limits.retryBaseMs * 2 ** attempt;
        emit({ type: "retry", callId, attempt: attempt + 1, delayMs: delay, reason: `${err.code}: ${result.envelope.summary ?? "retryable error"}` });
        await sleep(delay, signal);
        if (signal.aborted) break;
        result = await qloo.call(tool.name, callArgs, signal);
      }

      const rec = store.addCall({
        callId,
        tool: tool.name,
        args: callArgs,
        envelope: result.envelope,
        durationMs: result.durationMs,
        cached: result.cached,
        sample: deps.sample || result.envelope.fixture === true,
      });
      emit({ type: "tool_result", result: rec.view });
      if (rec.status === "ok" || rec.status === "partial" || rec.status === "degraded") session.unreportedCalls += 1;

      if (rec.status === "empty") notes.push("No results. Broaden once (drop a filter or rephrase) before giving up.");
      if (rec.status === "partial" || rec.status === "degraded") notes.push(`Lower-confidence result (${rec.status}); the report will flag it.`);

      if (rec.status === "needs_input") {
        const issues = store.issuesFor(callId, result.envelope);
        if (issues.length > 0) {
          notes.push("The user will be asked to choose; do not call more tools this turn and do not guess.");
          return { content: digestFor(rec, notes), issues };
        }
        notes.push(`Qloo says the input is incomplete: ${rec.summary}. Correct the arguments and retry.`);
      }
      const err = result.envelope.error;
      if (rec.status === "error" && err && FATAL_CODES.has(err.code)) {
        return { content: digestFor(rec), fatal: { code: err.code, message: `${rec.summary} ${err.recovery}`.trim() } };
      }
      return { content: digestFor(rec, notes) };
    };

    // ---- the loop
    while (steps < limits.maxSteps) {
      if (signal.aborted) return finish("aborted");
      steps += 1;
      compactHistory(session.messages);

      const mustReport = session.unreportedCalls > 0 && (steps === limits.maxSteps || budgetUsed());
      let tools = specs;
      let toolChoice: ToolChoice | undefined;
      if (mustReport) {
        tools = specs.filter((s) => s.function.name === SUBMIT_REPORT);
        toolChoice = { type: "function", function: { name: SUBMIT_REPORT } };
        const last = session.messages[session.messages.length - 1];
        if (!(last?.role === "user" && last.content.startsWith("Out of budget"))) {
          session.messages.push({ role: "user", content: "Out of budget for further tool calls. Call submit_report now with what you have." });
        }
      }

      let resp: ChatResponse;
      try {
        resp = await chat(tools, toolChoice);
      } catch (error) {
        if (signal.aborted) return finish("aborted");
        if (toolChoice && error instanceof LlmError && error.status === 400) {
          // Some servers reject a forced tool_choice; the single remaining tool plus the nudge is enough.
          try {
            resp = await chat(tools);
          } catch (e2) {
            emit({ type: "error", code: "LLM_ERROR", message: e2 instanceof Error ? e2.message : String(e2), retryable: e2 instanceof LlmError && e2.retryable });
            return finish("error");
          }
        } else {
          emit({ type: "error", code: "LLM_ERROR", message: error instanceof Error ? error.message : String(error), retryable: error instanceof LlmError && error.retryable });
          return finish("error");
        }
      }

      session.messages.push({ role: "assistant", content: resp.content || null, ...(resp.toolCalls.length ? { tool_calls: resp.toolCalls } : {}) });

      // ---- no tool calls: a final answer (or an unstructured report)
      if (resp.toolCalls.length === 0) {
        const asJson = session.unreportedCalls > 0 ? extractJsonObject(resp.content) : undefined;
        const looksLikeReport = asJson && typeof asJson === "object" && ("bridge_shelf" in asJson || "buy_list" in asJson);
        if (looksLikeReport) {
          const out = processSubmission(asJson);
          if (out.published) return finish("completed");
          session.messages.push({ role: "user", content: `That report was not accepted: ${out.content}. Call submit_report with the corrected report.` });
          continue;
        }
        if (session.unreportedCalls > 0 && !nudged) {
          nudged = true;
          session.messages.push({ role: "user", content: "Now call submit_report with the complete report, using refs from the tool results. Do not write the report as plain text." });
          continue;
        }
        if (resp.content) emit({ type: "message", text: resp.content });
        if (session.unreportedCalls > 0) {
          emit({ type: "error", code: "NO_REPORT", message: "The assistant stopped without producing a report.", retryable: true });
          return finish("error");
        }
        return finish("completed");
      }

      if (resp.content) emit({ type: "note", text: resp.content.slice(0, 320) });

      // ---- execute this turn's tool calls
      const planned = resp.toolCalls.map((call) => {
        const isQloo = !LOCAL_TOOLS.has(call.function.name);
        return { call, isQloo, callId: isQloo ? session.store.nextCallId() : "" };
      });
      const hasQloo = planned.some((p) => p.isQloo && toolsByName.has(p.call.function.name));

      const outcomes = await Promise.all(
        planned.map(async ({ call, isQloo, callId }): Promise<ToolOutcome> => {
          const name = call.function.name;
          const args = parseArgs(call.function.arguments);
          if (!args) return { content: JSON.stringify({ status: "error", error: { code: "INVALID_JSON", retryable: false, recovery: "Arguments must be one JSON object." } }) };

          if (name === SET_PLAN) {
            const raw = Array.isArray(args["steps"]) ? (args["steps"] as unknown[]) : [];
            const planSteps: PlanStep[] = raw.flatMap((s) => {
              const o = s as { title?: unknown; tool?: unknown };
              return typeof o?.title === "string" && o.title.trim()
                ? [{ title: o.title.trim().slice(0, 90), ...(typeof o.tool === "string" && o.tool.startsWith("qloo_") ? { tool: o.tool } : {}) }]
                : [];
            });
            if (planSteps.length) emit({ type: "plan", steps: planSteps.slice(0, 8) });
            return { content: '{"ok":true}' };
          }

          if (name === SUBMIT_REPORT) {
            if (hasQloo) return { content: JSON.stringify({ ok: false, problems: ["Call submit_report in its own turn, after you have seen the results of your tool calls."] }) };
            const out = processSubmission(args);
            return { content: out.content, reportPublished: out.published };
          }

          if (!isQloo) return { content: "{}" };
          const tool = toolsByName.get(name);
          if (!tool) return { content: JSON.stringify({ status: "error", error: { code: "UNKNOWN_TOOL", retryable: false, recovery: `No tool named ${name}. Available: ${[...toolsByName.keys(), SET_PLAN, SUBMIT_REPORT].join(", ")}` } }) };
          if (budgetUsed()) {
            return { content: JSON.stringify({ status: "error", error: { code: "TOOL_BUDGET_EXHAUSTED", retryable: false, recovery: "No more tool calls are allowed in this request. Call submit_report now." } }) };
          }
          toolCalls += 1;
          session.toolCallsTotal += 1;
          return execQloo(call, callId, tool, args);
        }),
      );

      planned.forEach((p, i) => session.messages.push({ role: "tool", tool_call_id: p.call.id, content: outcomes[i]!.content }));

      const fatal = outcomes.find((o) => o.fatal)?.fatal;
      if (fatal) {
        emit({ type: "error", code: fatal.code, message: fatal.message, retryable: false });
        return finish("error");
      }
      if (outcomes.some((o) => o.reportPublished)) return finish("completed");

      const issues = outcomes.flatMap((o) => o.issues ?? []);
      if (issues.length > 0) {
        session.pending.clear();
        for (const issue of issues) {
          const callId = issue.issueId.split(".")[0] ?? "";
          const tool = session.store.call(callId)?.tool ?? "";
          session.pending.set(issue.issueId, { ...issue, callId, tool });
        }
        const first = issues[0]!;
        const firstCall = first.issueId.split(".")[0] ?? "";
        emit({
          type: "needs_input",
          callId: firstCall,
          tool: session.store.call(firstCall)?.tool ?? "",
          message: issues.length === 1 ? `Qloo needs you to confirm "${first.input}".` : `Qloo needs you to confirm ${issues.length} items.`,
          issues,
        });
        return finish("awaiting_input");
      }
    }

    if (session.unreportedCalls > 0) {
      emit({ type: "error", code: "MAX_STEPS", message: "The assistant reached its step limit before finishing the report.", retryable: true });
    }
    return finish("max_steps");
  } catch (error) {
    if (signal.aborted) return finish("aborted");
    emit({ type: "error", code: "INTERNAL", message: "Something went wrong inside Shelfwise. Please try again.", retryable: true });
    // eslint-disable-next-line no-console
    console.error("agent loop failure:", error instanceof Error ? error.stack : error);
    return finish("error");
  }
}
