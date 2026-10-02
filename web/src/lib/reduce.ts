import type {
  AgentEvent,
  DoneReason,
  PlanStep,
  Report,
  ResolutionIssue,
  RunRequest,
  ToolCallView,
  ToolResultView,
} from "@shared/types";
import type { RunFailure } from "./failure";

export type RunStatus = "idle" | "streaming" | "awaiting_input" | "finished";

export interface RetryNote {
  attempt: number;
  delayMs: number;
  reason: string;
}

export interface CallEntry {
  call: ToolCallView;
  result: ToolResultView | null;
  retries: RetryNote[];
  /** 1-based position across the whole session. */
  step: number;
  /** Index into RunState.turns. */
  turn: number;
}

/** One request/response round: the original search, then each follow-up message. */
export interface Turn {
  label: string;
}

export interface ChatMessage {
  role: "user" | "assistant";
  text: string;
}

export interface PendingInput {
  callId: string;
  tool: string;
  message: string;
  issues: ResolutionIssue[];
}

export interface DoneInfo {
  reason: DoneReason;
  /** Null when the user stopped the run: the server never reported a count. */
  steps: number | null;
}

export interface RunState {
  status: RunStatus;
  sessionId: string | null;
  mode: "live" | "fixtures" | null;
  /** Index of the current turn in `turns`. Calls and report belong to turns; plan and notes are per turn. */
  turn: number;
  turns: Turn[];
  started: boolean;
  queue: { position: number; ahead: number } | null;
  plan: PlanStep[] | null;
  notes: string[];
  calls: CallEntry[];
  pending: PendingInput | null;
  report: Report | null;
  /** Turn in which the latest report arrived. */
  reportTurn: number | null;
  /** Counts report events, so the view can tell "first report" from "updated report". */
  reportCount: number;
  messages: ChatMessage[];
  error: RunFailure | null;
  done: DoneInfo | null;
  lastRequest: RunRequest | null;
  /** Short plain-text status for the screen-reader live region. */
  announce: string;
}

export const initialRunState: RunState = {
  status: "idle",
  sessionId: null,
  mode: null,
  turn: 0,
  turns: [{ label: "Your request" }],
  started: false,
  queue: null,
  plan: null,
  notes: [],
  calls: [],
  pending: null,
  report: null,
  reportTurn: null,
  reportCount: 0,
  messages: [],
  error: null,
  done: null,
  lastRequest: null,
  announce: "",
};

export type RunAction =
  | { type: "submit"; request: RunRequest; retry?: boolean }
  | { type: "event"; event: AgentEvent }
  | { type: "failed"; failure: RunFailure }
  | { type: "stopped" }
  | { type: "reset" };

export function currentTurnCalls(state: RunState): CallEntry[] {
  return state.calls.filter((entry) => entry.turn === state.turn);
}

function submit(state: RunState, request: RunRequest, retry: boolean): RunState {
  const common = { status: "streaming" as const, error: null, done: null, queue: null, lastRequest: request };
  switch (request.input.kind) {
    case "form":
      return { ...initialRunState, ...common, announce: "Starting your search." };
    case "resolution":
      return { ...state, ...common, pending: null, announce: "Continuing with your answers." };
    case "message": {
      const turn = retry ? state.turn : state.turn + 1;
      return {
        ...state,
        ...common,
        pending: null,
        started: false,
        plan: null,
        notes: [],
        turn,
        turns: retry ? state.turns : [...state.turns, { label: request.input.text }],
        messages: retry ? state.messages : [...state.messages, { role: "user", text: request.input.text }],
        announce: "Working on your follow-up.",
      };
    }
  }
}

function applyEvent(state: RunState, event: AgentEvent): RunState {
  switch (event.type) {
    case "session":
      return { ...state, sessionId: event.sessionId, mode: event.mode };
    case "queued":
      return {
        ...state,
        queue: { position: event.position, ahead: event.ahead },
        announce: event.position <= 1 ? "Waiting for a free slot. You are next." : `Waiting for a free slot. ${event.ahead} ahead of you.`,
      };
    case "started":
      return { ...state, started: true, queue: null, announce: "The agent has started." };
    case "plan":
      return { ...state, plan: event.steps };
    case "note":
      return { ...state, notes: [...state.notes, event.text] };
    case "tool_call": {
      const entry: CallEntry = {
        call: event.call,
        result: null,
        retries: [],
        step: state.calls.length + 1,
        turn: state.turn,
      };
      const rest = state.calls.filter((c) => c.call.callId !== event.call.callId);
      return { ...state, queue: null, calls: [...rest, entry], announce: `Checking Qloo: ${event.call.label}` };
    }
    case "tool_result": {
      const { result } = event;
      const known = state.calls.some((c) => c.call.callId === result.callId);
      if (!known) {
        // A result with no preceding call (for example a dropped message): keep it visible in the trail.
        const entry: CallEntry = {
          call: { callId: result.callId, tool: result.tool, args: {}, label: result.tool },
          result,
          retries: [],
          step: state.calls.length + 1,
          turn: state.turn,
        };
        return { ...state, calls: [...state.calls, entry] };
      }
      return {
        ...state,
        calls: state.calls.map((c) => (c.call.callId === result.callId ? { ...c, result } : c)),
      };
    }
    case "retry":
      return {
        ...state,
        calls: state.calls.map((c) =>
          c.call.callId === event.callId
            ? { ...c, retries: [...c.retries, { attempt: event.attempt, delayMs: event.delayMs, reason: event.reason }] }
            : c,
        ),
        announce: `Retrying a lookup, attempt ${event.attempt}.`,
      };
    case "needs_input":
      return {
        ...state,
        status: "awaiting_input",
        pending: { callId: event.callId, tool: event.tool, message: event.message, issues: event.issues },
        announce: "Shelfwise needs your help to choose between matches.",
      };
    case "report":
      return {
        ...state,
        report: event.report,
        reportTurn: state.turn,
        reportCount: state.reportCount + 1,
        announce: "Your shelf is ready.",
      };
    case "message":
      return { ...state, messages: [...state.messages, { role: "assistant", text: event.text }], announce: "Shelfwise replied." };
    case "error":
      return {
        ...state,
        error: { kind: "agent", code: event.code, message: event.message, retryable: event.retryable },
        announce: `Something went wrong: ${event.message}`,
      };
    case "done": {
      const waiting = event.reason === "awaiting_input" && state.pending !== null;
      return {
        ...state,
        status: waiting ? "awaiting_input" : "finished",
        queue: null,
        done: { reason: event.reason, steps: event.steps },
        announce: doneAnnouncement(event.reason),
      };
    }
  }
}

function doneAnnouncement(reason: DoneReason): string {
  switch (reason) {
    case "completed":
      return "Finished.";
    case "awaiting_input":
      return "Paused for your answers.";
    case "max_steps":
      return "The agent reached its step limit.";
    case "error":
      return "The run ended with an error.";
    case "aborted":
      return "Stopped.";
  }
}

/** True when a failure happened before the first request produced anything to show. */
function failedBeforeStart(state: RunState): boolean {
  return state.lastRequest?.input.kind === "form" && state.sessionId === null && !state.started && state.calls.length === 0;
}

export function runReducer(state: RunState, action: RunAction): RunState {
  switch (action.type) {
    case "submit":
      return submit(state, action.request, action.retry ?? false);
    case "event":
      return applyEvent(state, action.event);
    case "failed": {
      const beforeStart = failedBeforeStart(state);
      return {
        ...state,
        status: beforeStart ? "idle" : "finished",
        queue: null,
        error: action.failure,
        done: beforeStart ? null : { reason: "error", steps: null },
        announce: action.failure.message,
      };
    }
    case "stopped":
      return {
        ...state,
        status: "finished",
        queue: null,
        error: null,
        done: { reason: "aborted", steps: null },
        announce: "Stopped.",
      };
    case "reset":
      return initialRunState;
  }
}
