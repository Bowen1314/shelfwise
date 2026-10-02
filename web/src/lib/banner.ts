import type { HealthResponse } from "@shared/types";

/**
 * The second half of the sample-data banner. The Qloo data is always placeholder data in this mode, but the planner
 * can be either the scripted placeholder or a real language model (when the server has a model key), and the page
 * must not leave the reader guessing which.
 */
/** A short note for narrow screens, where the long detail line is hidden. Null when the planner is the scripted one. */
export function sampleBannerPlanner(llm: HealthResponse["llm"] | undefined): string | null {
  return llm && !llm.scripted ? "Real language model, sample data" : null;
}

export function sampleBannerDetail(llm: HealthResponse["llm"] | undefined): string {
  if (llm && !llm.scripted) {
    return `Titles, scores and trends here are built-in placeholders. The plan and report are written by a real language model (${llm.model}) working on that sample data.`;
  }
  return "Titles, scores and trends here are built-in placeholders, for illustration only.";
}
