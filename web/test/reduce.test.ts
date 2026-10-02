import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { AgentEvent, FormInput, Report, ToolResultView } from "@shared/types";
import { currentTurnCalls, initialRunState, runReducer, type RunAction, type RunState } from "../src/lib/reduce";
import { derivePhases, derivePlan } from "../src/lib/progress";
import { DROPPED_FAILURE } from "../src/lib/failure";
import { summarizeWork } from "../src/lib/format";

const form: FormInput = { place: "Newark, NJ", ageBand: "any", interests: "Severance", titleCount: 8 };

function fold(actions: RunAction[], from: RunState = initialRunState): RunState {
  return actions.reduce(runReducer, from);
}

const ev = (event: AgentEvent): RunAction => ({ type: "event", event });
const submitForm: RunAction = { type: "submit", request: { input: { kind: "form", form } } };

function resultOf(callId: string, tool: string, status: ToolResultView["status"] = "ok"): ToolResultView {
  return {
    callId,
    tool,
    status,
    summary: "",
    durationMs: 1,
    cached: false,
    sample: true,
    resolved: [],
    requests: [],
    resultCount: 0,
    preview: [],
    warnings: [],
    raw: null,
  };
}

const call = (callId: string, tool: string): AgentEvent => ({ type: "tool_call", call: { callId, tool, args: {}, label: `label ${callId}` } });
const report = (version: number): Report => ({
  version,
  createdAt: "",
  sample: true,
  place: "Newark, NJ",
  audience: "",
  bridgeShelf: [],
  buyList: [],
  programmes: [],
  notes: [],
});

describe("runReducer", () => {
  it("folds a normal run into calls, report and done", () => {
    const state = fold([
      submitForm,
      ev({ type: "session", sessionId: "s1", runId: "r1", mode: "fixtures" }),
      ev({ type: "queued", position: 1, ahead: 0 }),
      ev({ type: "started" }),
      ev({ type: "plan", steps: [{ title: "Look up", tool: "qloo_describe" }] }),
      ev({ type: "note", text: "Working" }),
      ev(call("c1", "qloo_describe")),
      ev({ type: "tool_result", result: resultOf("c1", "qloo_describe") }),
      ev({ type: "report", report: report(1) }),
      ev({ type: "done", reason: "completed", steps: 2, toolCalls: 1 }),
    ]);
    assert.equal(state.status, "finished");
    assert.equal(state.sessionId, "s1");
    assert.equal(state.queue, null);
    assert.equal(state.calls.length, 1);
    assert.equal(state.calls[0]?.result?.status, "ok");
    assert.equal(state.calls[0]?.step, 1);
    assert.equal(state.report?.version, 1);
    assert.equal(state.reportCount, 1);
    assert.deepEqual(state.notes, ["Working"]);
  });

  it("records retries against the call and keeps the call open", () => {
    const state = fold([submitForm, ev(call("c1", "qloo_recommend")), ev({ type: "retry", callId: "c1", attempt: 2, delayMs: 800, reason: "503" })]);
    assert.equal(state.calls[0]?.result, null);
    assert.deepEqual(state.calls[0]?.retries, [{ attempt: 2, delayMs: 800, reason: "503" }]);
  });

  it("pauses on needs_input and resumes on a resolution submit in the same turn", () => {
    const paused = fold([
      submitForm,
      ev(call("c1", "qloo_describe")),
      ev({ type: "tool_result", result: resultOf("c1", "qloo_describe", "needs_input") }),
      ev({ type: "needs_input", callId: "c1", tool: "qloo_describe", message: "Which?", issues: [] }),
      ev({ type: "done", reason: "awaiting_input", steps: 1, toolCalls: 1 }),
    ]);
    assert.equal(paused.status, "awaiting_input");
    assert.equal(paused.pending?.callId, "c1");

    const resumed = runReducer(paused, { type: "submit", request: { sessionId: "s1", input: { kind: "resolution", choices: [] } } });
    assert.equal(resumed.status, "streaming");
    assert.equal(resumed.pending, null);
    assert.equal(resumed.turn, 0);
    assert.equal(resumed.calls.length, 1);
  });

  it("starts a new turn for a follow-up message and keeps earlier calls and the report", () => {
    const first = fold([submitForm, ev(call("c1", "qloo_recommend")), ev({ type: "tool_result", result: resultOf("c1", "qloo_recommend") }), ev({ type: "report", report: report(1) }), ev({ type: "done", reason: "completed", steps: 1, toolCalls: 1 })]);
    const second = fold(
      [{ type: "submit", request: { sessionId: "s1", input: { kind: "message", text: "Shorter list" } } }, ev(call("c2", "qloo_recommend")), ev({ type: "report", report: report(2) })],
      first,
    );
    assert.equal(second.turn, 1);
    assert.equal(second.turns[1]?.label, "Shorter list");
    assert.equal(second.calls.length, 2);
    assert.equal(currentTurnCalls(second).length, 1);
    assert.equal(second.report?.version, 2);
    assert.equal(second.reportCount, 2);
    assert.deepEqual(second.messages, [{ role: "user", text: "Shorter list" }]);
  });

  it("does not add a second user bubble or a second turn when a follow-up is retried", () => {
    const request = { sessionId: "s1", input: { kind: "message", text: "More fiction" } } as const;
    const once = runReducer(initialRunState, { type: "submit", request });
    const failed = runReducer(once, { type: "failed", failure: DROPPED_FAILURE });
    const again = runReducer(failed, { type: "submit", request, retry: true });
    assert.equal(again.messages.length, 1);
    assert.equal(again.turn, once.turn);
  });

  it("returns to the form (idle) when the very first request fails before anything arrives", () => {
    const state = fold([submitForm, { type: "failed", failure: DROPPED_FAILURE }]);
    assert.equal(state.status, "idle");
    assert.equal(state.error?.code, "stream_dropped");
    assert.deepEqual(state.lastRequest, { input: { kind: "form", form } });
  });

  it("keeps the run view when a stream drops mid-run", () => {
    const state = fold([submitForm, ev({ type: "started" }), ev(call("c1", "qloo_describe")), { type: "failed", failure: DROPPED_FAILURE }]);
    assert.equal(state.status, "finished");
    assert.equal(state.calls.length, 1);
  });

  it("records an error event and ends with done(error)", () => {
    const state = fold([submitForm, ev({ type: "error", code: "x", message: "Broke", retryable: true }), ev({ type: "done", reason: "error", steps: 0, toolCalls: 0 })]);
    assert.equal(state.error?.message, "Broke");
    assert.equal(state.status, "finished");
  });

  it("marks a stopped run as aborted and keeps what arrived", () => {
    const state = fold([submitForm, ev(call("c1", "qloo_describe")), { type: "stopped" }]);
    assert.equal(state.status, "finished");
    assert.equal(state.done?.reason, "aborted");
    assert.equal(state.done?.steps, null);
    assert.equal(state.calls.length, 1);
  });

  it("starts from a clean state on a new form submit", () => {
    const used = fold([submitForm, ev({ type: "report", report: report(1) })]);
    const fresh = runReducer(used, submitForm);
    assert.equal(fresh.report, null);
    assert.equal(fresh.reportCount, 0);
    assert.equal(fresh.calls.length, 0);
  });

  it("keeps a result that arrives without its call", () => {
    const state = fold([submitForm, ev({ type: "tool_result", result: resultOf("c9", "qloo_rank") })]);
    assert.equal(state.calls[0]?.call.callId, "c9");
  });
});

describe("progress", () => {
  it("ticks plan steps when matching tool results arrive, one step per result", () => {
    const state = fold([
      submitForm,
      ev(call("c1", "qloo_recommend")),
      ev({ type: "tool_result", result: resultOf("c1", "qloo_recommend") }),
      ev(call("c2", "qloo_recommend")),
    ]);
    const plan = [
      { title: "Recommend A", tool: "qloo_recommend" },
      { title: "Recommend B", tool: "qloo_recommend" },
      { title: "Write up" },
    ];
    const items = derivePlan(plan, state.calls, "streaming", false);
    assert.deepEqual(items.map((i) => i.state), ["done", "active", "pending"]);
    const done = derivePlan(plan, state.calls, "finished", true);
    assert.equal(done[2]?.state, "done");
  });

  it("derives phases from tool names", () => {
    const state = fold([
      submitForm,
      ev({ type: "started" }),
      ev(call("c1", "qloo_describe")),
      ev({ type: "tool_result", result: resultOf("c1", "qloo_describe") }),
      ev(call("c2", "qloo_recommend")),
    ]);
    const phases = derivePhases({ calls: state.calls, status: "streaming", reported: false });
    const byId = Object.fromEntries(phases.map((p) => [p.id, p.state]));
    assert.equal(byId["resolve"], "done");
    assert.equal(byId["recommend"], "active");
    assert.equal(byId["rank"], "pending");
    assert.equal(byId["write"], "pending");
  });

  it("flags the phase that is waiting on the user and shows unused phases as skipped once finished", () => {
    const state = fold([
      submitForm,
      ev(call("c1", "qloo_describe")),
      ev({ type: "tool_result", result: resultOf("c1", "qloo_describe", "needs_input") }),
    ]);
    const phases = derivePhases({ calls: state.calls, status: "awaiting_input", reported: false });
    assert.equal(phases.find((p) => p.id === "resolve")?.state, "attention");
    assert.equal(phases.find((p) => p.id === "compare")?.state, "skipped");
  });

  it("words the work summary for finished, stopped and capped runs", () => {
    const base = [submitForm, ev(call("c1", "qloo_recommend")), ev({ type: "tool_result", result: resultOf("c1", "qloo_recommend") })];
    const done = fold([...base, ev({ type: "done", reason: "completed", steps: 3, toolCalls: 1 })]);
    assert.equal(summarizeWork(done.done, done.calls), "Done in 3 steps · 1 sample lookup");
    const capped = fold([...base, ev({ type: "done", reason: "max_steps", steps: 8, toolCalls: 1 })]);
    assert.equal(summarizeWork(capped.done, capped.calls), "Step limit reached after 8 steps · 1 sample lookup");
    const stopped = fold([...base, { type: "stopped" }]);
    assert.equal(summarizeWork(stopped.done, stopped.calls), "Stopped · 1 sample lookup");
    const dropped = fold([...base, { type: "failed", failure: DROPPED_FAILURE }]);
    assert.equal(summarizeWork(dropped.done, dropped.calls), "Ended with an error · 1 sample lookup");
  });

  it("shows a phase whose call never finished as interrupted once the run has ended", () => {
    const state = fold([submitForm, ev(call("c1", "qloo_recommend")), { type: "stopped" }]);
    const phases = derivePhases({ calls: state.calls, status: state.status, reported: false });
    assert.equal(phases.find((p) => p.id === "recommend")?.state, "interrupted");
  });
});
