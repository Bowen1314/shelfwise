import type { PlanStep } from "@shared/types";
import type { CallEntry, RunStatus } from "./reduce";

/** "qloo_recommend" -> "recommend": the prefix is noise in the interface. */
export function shortTool(tool: string): string {
  return tool.replace(/^qloo_/, "");
}

export type PhaseId = "resolve" | "recommend" | "rank" | "local" | "trends" | "compare" | "write";

const PHASE_LABELS: Record<PhaseId, string> = {
  resolve: "Resolve",
  recommend: "Recommend",
  rank: "Rank",
  local: "Local fit",
  trends: "Trends",
  compare: "Compare",
  write: "Write up",
};

const PHASE_ORDER: PhaseId[] = ["resolve", "recommend", "rank", "local", "trends", "compare", "write"];

const TOOL_PHASE: Record<string, PhaseId> = {
  describe: "resolve",
  find_tags: "resolve",
  recommend: "recommend",
  rank: "rank",
  where_popular: "local",
  trends: "trends",
  compare_audiences: "compare",
};

export function phaseOfTool(tool: string): PhaseId | null {
  return TOOL_PHASE[shortTool(tool)] ?? null;
}

/**
 * pending   - not reached yet
 * active    - a call in this phase is running now
 * attention   - the agent is waiting on the user in this phase
 * done        - every call in the phase has finished
 * skipped     - the run ended without using this phase
 * interrupted - the run ended (stopped, dropped, failed) while a call in this phase was still open
 */
export type PhaseState = "pending" | "active" | "attention" | "done" | "skipped" | "interrupted";

export interface PhaseView {
  id: PhaseId;
  label: string;
  state: PhaseState;
}

interface PhaseInput {
  calls: CallEntry[];
  status: RunStatus;
  /** A report has arrived during this turn. */
  reported: boolean;
}

export function derivePhases({ calls, status, reported }: PhaseInput): PhaseView[] {
  const live = status === "streaming";
  const ended = status === "finished" || status === "awaiting_input";
  const anyRunning = calls.some((c) => c.result === null);

  return PHASE_ORDER.map((id): PhaseView => {
    const label = PHASE_LABELS[id];
    if (id === "write") {
      if (reported) return { id, label, state: "done" };
      if (live && calls.length > 0 && !anyRunning) return { id, label, state: "active" };
      return { id, label, state: ended ? "skipped" : "pending" };
    }
    const inPhase = calls.filter((c) => phaseOfTool(c.call.tool) === id);
    if (inPhase.length === 0) return { id, label, state: ended ? "skipped" : "pending" };
    if (inPhase.some((c) => c.result === null)) return { id, label, state: live ? "active" : "interrupted" };
    if (status === "awaiting_input" && inPhase.some((c) => c.result?.status === "needs_input")) {
      return { id, label, state: "attention" };
    }
    return { id, label, state: "done" };
  });
}

export type PlanItemState = "done" | "active" | "pending";

export interface PlanItemView {
  step: PlanStep;
  state: PlanItemState;
}

/**
 * Ticks a plan step when a settled result for its tool arrives (one step per result, in plan order). A result
 * that is waiting on the user or failed does not count. Steps with no tool, such as the final write-up, tick
 * when the report arrives.
 */
export function derivePlan(plan: PlanStep[], calls: CallEntry[], status: RunStatus, reported: boolean): PlanItemView[] {
  const finishedTools = calls
    .filter((c) => c.result !== null && c.result.status !== "needs_input" && c.result.status !== "error")
    .map((c) => shortTool(c.call.tool));
  const used = new Array<boolean>(finishedTools.length).fill(false);

  const ticked = plan.map((step) => {
    if (!step.tool) return reported;
    const wanted = shortTool(step.tool);
    const index = finishedTools.findIndex((tool, i) => tool === wanted && !used[i]);
    if (index === -1) return false;
    used[index] = true;
    return true;
  });

  const firstOpen = ticked.indexOf(false);
  return plan.map((step, i): PlanItemView => {
    if (ticked[i]) return { step, state: "done" };
    return { step, state: i === firstOpen && status === "streaming" ? "active" : "pending" };
  });
}
