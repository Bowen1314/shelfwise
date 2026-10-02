import type { DoneReason, EntityRef, ProgrammeKind, ToolStatus, TrendDirection } from "@shared/types";
import type { CallEntry, DoneInfo } from "./reduce";

export function plural(count: number, one: string, many = `${one}s`): string {
  return count === 1 ? one : many;
}

export function formatDuration(ms: number): string {
  if (ms < 1000) return `${Math.round(ms)} ms`;
  return `${(ms / 1000).toFixed(1)} s`;
}

const ENTITY_TYPE_LABELS: Record<string, string> = {
  artist: "Artist",
  album: "Album",
  book: "Book",
  brand: "Brand",
  destination: "Destination",
  movie: "Film",
  person: "Person",
  place: "Place",
  podcast: "Podcast",
  tv_show: "TV show",
  video_game: "Video game",
};

/** Qloo entity types arrive as "tv_show" or "urn:entity:tv_show"; show them as people say them. */
export function entityTypeLabel(type: string | undefined): string | null {
  if (!type) return null;
  const bare = type.replace(/^urn:(entity|tag):/, "").replace(/^.*:/, "");
  const known = ENTITY_TYPE_LABELS[bare];
  if (known) return known;
  const spaced = bare.replace(/_/g, " ");
  return spaced.charAt(0).toUpperCase() + spaced.slice(1);
}

export function entityTitle(entity: Pick<EntityRef, "name" | "year">): string {
  return entity.year ? `${entity.name} (${entity.year})` : entity.name;
}

export interface StatusMeta {
  label: string;
  tone: "ok" | "empty" | "input" | "partial" | "degraded" | "error";
}

export const STATUS_META: Record<ToolStatus, StatusMeta> = {
  ok: { label: "OK", tone: "ok" },
  empty: { label: "No results", tone: "empty" },
  needs_input: { label: "Needs input", tone: "input" },
  partial: { label: "Partial", tone: "partial" },
  degraded: { label: "Degraded", tone: "degraded" },
  error: { label: "Error", tone: "error" },
};

export const TREND_LABELS: Record<TrendDirection, string> = {
  rising: "Rising",
  fading: "Fading",
  steady: "Steady",
  unknown: "Unknown",
};

export const PROGRAMME_LABELS: Record<ProgrammeKind, string> = {
  film_night: "Film night",
  themed_display: "Themed display",
  book_club: "Book club",
  other: "Idea",
};

const DONE_LEADS: Partial<Record<DoneReason, string>> = {
  aborted: "Stopped",
  max_steps: "Step limit reached",
  error: "Ended with an error",
};

/** "Done in 9 steps · 8 Qloo calls (2 cached)". Cached results made no Qloo call; sample results never reach Qloo. */
export function summarizeWork(done: DoneInfo | null, calls: CallEntry[]): string {
  const finished = calls.filter((c) => c.result !== null);
  const cached = finished.filter((c) => c.result?.cached).length;
  const sampleOnly = finished.length > 0 && finished.every((c) => c.result?.sample);
  const live = finished.length - cached;
  const steps = done ? done.steps : calls.length;
  const noun = sampleOnly ? plural(live, "sample lookup") : plural(live, "Qloo call");
  const cachedPart = cached > 0 ? ` (${cached} cached)` : "";
  const lead = DONE_LEADS[done?.reason ?? "completed"] ?? "Done";
  const connector = lead === "Done" ? "in" : "after";
  const stepsPart = steps === null ? "" : ` ${connector} ${steps} ${plural(steps, "step")}`;
  return `${lead}${stepsPart} · ${live} ${noun}${cachedPart}`;
}

/** Plain-language list: "a, b and c". */
export function joinNames(names: string[]): string {
  if (names.length <= 1) return names.join("");
  return `${names.slice(0, -1).join(", ")} and ${names[names.length - 1]}`;
}
