import type {
  BridgeCard,
  BuyItem,
  Cite,
  EntityRef,
  LocalFit,
  ProgrammeIdea,
  Report,
  ReportNote,
  ToolCallView,
  ToolResultView,
  TrendSummary,
} from "@shared/types";
import type { CallEntry, RetryNote, RunState, Turn } from "./reduce";

/*
 * Recent runs: the last few finished reports, kept in this browser's localStorage so staff can reopen or reprint
 * them without running the agent again. Nothing here talks to the server.
 *
 * Every read and write is guarded: storage can be missing, blocked, full or hold anything at all, and the page has
 * to keep working in each case. This module has no React or DOM dependencies; the storage is injectable.
 */

export const RECENT_RUNS_KEY = "shelfwise-recent-runs";
export const MAX_RECENT_RUNS = 10;

/** Shown in the trail's "Raw Qloo result" expander for a reopened run. */
export const RAW_NOT_KEPT = "The raw Qloo result is not kept for recent runs.";

/** The parts of the Web Storage API this module uses. */
export interface StorageLike {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
}

/** A trail entry as stored: the tool result without its raw envelope, which is most of the bytes. */
export type SavedCall = Omit<CallEntry, "result"> & { result: Omit<ToolResultView, "raw"> | null };

export interface RecentRun {
  sessionId: string;
  /** Epoch milliseconds of the save (a follow-up in the same session saves again). */
  savedAt: number;
  place: string;
  interests: string;
  /** Age band label as chosen in the form, e.g. "Adults". */
  audience: string;
  titleCount: number;
  report: Report;
  calls: SavedCall[];
  turns: Turn[];
}

/** What the request looked like, as the form described it. */
export interface RunRequestSummary {
  place: string;
  interests: string;
  audience: string;
  titleCount: number;
}

/** localStorage, or null where reading the property itself throws (some privacy settings) or it does not exist. */
export function browserStorage(): StorageLike | null {
  try {
    const storage = (globalThis as { localStorage?: StorageLike }).localStorage;
    return storage ?? null;
  } catch {
    return null;
  }
}

function slimCall(entry: CallEntry): SavedCall {
  if (!entry.result) return { ...entry, result: null };
  const { raw: _raw, ...result } = entry.result;
  return { ...entry, result };
}

/**
 * The run worth keeping, or null. Only a run whose last turn completed with a report counts: one that paused for
 * the user's choice counts once that choice has been answered and the run has completed, never while it waits.
 */
export function recentRunFrom(state: RunState, request: RunRequestSummary | null, savedAt: number = Date.now()): RecentRun | null {
  const { report, sessionId } = state;
  if (state.status !== "finished" || state.done?.reason !== "completed" || state.error || !report || !sessionId) return null;
  return {
    sessionId,
    savedAt,
    place: request?.place ?? report.place,
    interests: request?.interests ?? "",
    // The report's audience is what was sent to Qloo; a follow-up ("make it for teens") can differ from the form.
    audience: report.audience || request?.audience || "",
    titleCount: request?.titleCount ?? report.buyList.length,
    report,
    calls: state.calls.map(slimCall),
    turns: state.turns,
  };
}

/** Trail entries for the evidence trail of a reopened run. The raw envelope is replaced by a short note. */
export function trailCalls(run: RecentRun): CallEntry[] {
  return run.calls.map((entry) => ({ ...entry, result: entry.result ? { ...entry.result, raw: RAW_NOT_KEPT } : null }));
}

// ---------------------------------------------------------------------------------------------
// Shape checks. Stored data is untrusted: an older version, another tab mid-write or a hand edit can leave
// anything there. An entry that would make a renderer throw is skipped rather than shown.
// ---------------------------------------------------------------------------------------------

type Obj = Record<string, unknown>;

const NOTE_KINDS: readonly ReportNote["kind"][] = ["guard", "reduced", "gap", "info"];
const PROGRAMME_KINDS: readonly ProgrammeIdea["kind"][] = ["film_night", "themed_display", "book_club", "other"];
const TREND_DIRECTIONS: readonly TrendSummary["direction"][] = ["rising", "fading", "steady", "unknown"];
const TOOL_STATUSES: readonly ToolResultView["status"][] = ["ok", "empty", "needs_input", "partial", "degraded", "error"];

const isObj = (value: unknown): value is Obj => typeof value === "object" && value !== null && !Array.isArray(value);
const isStr = (value: unknown): value is string => typeof value === "string";
const isNum = (value: unknown): value is number => typeof value === "number" && Number.isFinite(value);
const isBool = (value: unknown): value is boolean => typeof value === "boolean";
const optional = (value: unknown, check: (value: unknown) => boolean): boolean => value === undefined || check(value);
const arrayOf = (value: unknown, check: (value: unknown) => boolean): boolean => Array.isArray(value) && value.every(check);
const oneOf =
  <T>(allowed: readonly T[]) =>
  (value: unknown): boolean =>
    allowed.includes(value as T);

function isEntity(value: unknown): value is EntityRef {
  return isObj(value) && isStr(value.name) && isStr(value.handle) && optional(value.year, isNum) && optional(value.type, isStr);
}

function isCite(value: unknown): value is Cite {
  return isObj(value) && isStr(value.callId) && isStr(value.tool) && isStr(value.label);
}

function isTrend(value: unknown): value is TrendSummary {
  return isObj(value) && isStr(value.callId) && isEntity(value.entity) && oneOf(TREND_DIRECTIONS)(value.direction) && isStr(value.basis);
}

function isLocalFit(value: unknown): value is LocalFit {
  return isObj(value) && isStr(value.callId) && isEntity(value.entity) && isStr(value.within) && isNum(value.areas) && isStr(value.summary);
}

function isBridgeCard(value: unknown): value is BridgeCard {
  return (
    isObj(value) &&
    isStr(value.id) &&
    arrayOf(value.loved, isEntity) &&
    isEntity(value.book) &&
    isStr(value.why) &&
    arrayOf(value.cites, isCite) &&
    isBool(value.reduced)
  );
}

function isRecommendation(value: unknown): boolean {
  return isObj(value) && isStr(value.callId) && isNum(value.position) && isNum(value.of) && optional(value.signal, isEntity);
}

function isRank(value: unknown): boolean {
  return isObj(value) && isStr(value.callId) && isNum(value.position) && isNum(value.of);
}

function isBuyItem(value: unknown): value is BuyItem {
  if (!isObj(value) || !isObj(value.evidence)) return false;
  const evidence = value.evidence;
  return (
    isNum(value.rank) &&
    isEntity(value.book) &&
    isStr(value.rationale) &&
    arrayOf(value.cites, isCite) &&
    arrayOf(evidence.matchedSignals, isEntity) &&
    arrayOf(evidence.recommendations, isRecommendation) &&
    optional(evidence.rank, isRank) &&
    optional(evidence.localFit, isLocalFit) &&
    optional(evidence.trend, isTrend) &&
    optional(evidence.signalTrends, (trends) => arrayOf(trends, isTrend)) &&
    isBool(evidence.reduced)
  );
}

function isProgramme(value: unknown): value is ProgrammeIdea {
  return (
    isObj(value) &&
    isStr(value.id) &&
    oneOf(PROGRAMME_KINDS)(value.kind) &&
    isStr(value.title) &&
    isStr(value.description) &&
    arrayOf(value.books, isEntity) &&
    arrayOf(value.signals, isEntity) &&
    arrayOf(value.cites, isCite)
  );
}

function isNote(value: unknown): value is ReportNote {
  return isObj(value) && oneOf(NOTE_KINDS)(value.kind) && isStr(value.text);
}

function isReport(value: unknown): value is Report {
  return (
    isObj(value) &&
    isNum(value.version) &&
    isStr(value.createdAt) &&
    isBool(value.sample) &&
    isStr(value.place) &&
    isStr(value.audience) &&
    arrayOf(value.bridgeShelf, isBridgeCard) &&
    arrayOf(value.buyList, isBuyItem) &&
    arrayOf(value.programmes, isProgramme) &&
    arrayOf(value.notes, isNote) &&
    optional(value.budgetNote, isStr)
  );
}

function isCall(value: unknown): value is ToolCallView {
  return isObj(value) && isStr(value.callId) && isStr(value.tool) && isStr(value.label) && isObj(value.args);
}

function isResult(value: unknown): value is Omit<ToolResultView, "raw"> {
  return (
    isObj(value) &&
    isStr(value.callId) &&
    isStr(value.tool) &&
    oneOf(TOOL_STATUSES)(value.status) &&
    isStr(value.summary) &&
    isNum(value.durationMs) &&
    isBool(value.cached) &&
    isBool(value.sample) &&
    arrayOf(value.resolved, (item) => isObj(item) && isStr(item.input) && isEntity(item.entity)) &&
    arrayOf(value.requests, (item) => isObj(item) && isStr(item.path)) &&
    isNum(value.resultCount) &&
    arrayOf(value.preview, (row) => isObj(row) && isStr(row.name)) &&
    optional(value.trend, (trends) => arrayOf(trends, isTrend)) &&
    optional(value.local, isLocalFit) &&
    arrayOf(value.warnings, isStr) &&
    optional(value.error, (error) => isObj(error) && isStr(error.code) && isBool(error.retryable) && isStr(error.recovery))
  );
}

function isRetry(value: unknown): value is RetryNote {
  return isObj(value) && isNum(value.attempt) && isNum(value.delayMs) && isStr(value.reason);
}

function isSavedCall(value: unknown): value is SavedCall {
  return (
    isObj(value) &&
    isCall(value.call) &&
    (value.result === null || isResult(value.result)) &&
    arrayOf(value.retries, isRetry) &&
    isNum(value.step) &&
    isNum(value.turn)
  );
}

/** One stored entry, or null when it can't be shown safely. Bad trail entries are dropped; their cites go inert. */
function parseRun(value: unknown): RecentRun | null {
  if (!isObj(value)) return null;
  const { sessionId, savedAt, place, interests, audience, titleCount, report, calls, turns } = value;
  if (!isStr(sessionId) || sessionId === "" || !isNum(savedAt) || !isStr(place) || !isStr(interests)) return null;
  if (!isStr(audience) || !isNum(titleCount) || !isReport(report)) return null;
  return {
    sessionId,
    savedAt,
    place,
    interests,
    audience,
    titleCount,
    report,
    calls: Array.isArray(calls) ? calls.filter(isSavedCall) : [],
    turns: arrayOf(turns, (turn) => isObj(turn) && isStr(turn.label)) ? (turns as Turn[]) : [],
  };
}

/** Valid entries only, first occurrence of each session, at most MAX_RECENT_RUNS. */
export function parseRecentRuns(json: string | null): RecentRun[] {
  if (json === null) return [];
  let data: unknown;
  try {
    data = JSON.parse(json);
  } catch {
    return [];
  }
  if (!Array.isArray(data)) return [];
  const runs: RecentRun[] = [];
  const seen = new Set<string>();
  for (const item of data) {
    const run = parseRun(item);
    if (!run || seen.has(run.sessionId)) continue;
    seen.add(run.sessionId);
    runs.push(run);
    if (runs.length === MAX_RECENT_RUNS) break;
  }
  return runs;
}

// ---------------------------------------------------------------------------------------------
// Reading and writing
// ---------------------------------------------------------------------------------------------

/** The stored list, or null when storage can't be read at all (as opposed to holding nothing). */
function readRuns(storage: StorageLike | null): RecentRun[] | null {
  if (!storage) return null;
  let json: string | null;
  try {
    json = storage.getItem(RECENT_RUNS_KEY);
  } catch {
    return null;
  }
  return parseRecentRuns(json);
}

function isQuotaError(error: unknown): boolean {
  if (typeof error !== "object" || error === null) return false;
  const { name, code } = error as { name?: unknown; code?: unknown };
  return name === "QuotaExceededError" || name === "NS_ERROR_DOM_QUOTA_REACHED" || code === 22 || code === 1014;
}

/**
 * Writes the list. While the browser says storage is full, drops the oldest entry and tries again (at most once per
 * entry, and never dropping the newest). Returns what was stored, or null when nothing could be.
 */
function writeRuns(runs: RecentRun[], storage: StorageLike | null): RecentRun[] | null {
  if (!storage) return null;
  let list = runs;
  for (let attempt = 0; attempt <= runs.length; attempt++) {
    try {
      storage.setItem(RECENT_RUNS_KEY, JSON.stringify(list));
      return list;
    } catch (error) {
      if (!isQuotaError(error) || list.length <= 1) return null;
      list = list.slice(0, -1);
    }
  }
  return null;
}

/** The saved runs, newest first. Empty when storage is unavailable, empty or unreadable. */
export function loadRecentRuns(storage: StorageLike | null = browserStorage()): RecentRun[] {
  return readRuns(storage) ?? [];
}

/**
 * Adds a run at the top, replacing any earlier entry for the same session (a follow-up produces a new report
 * version for the same run), and keeps the newest MAX_RECENT_RUNS. Returns the list to show: what was stored, or,
 * when storage can't be used, `current` with the change applied so the page still lists it until reload.
 */
export function saveRecentRun(
  run: RecentRun,
  storage: StorageLike | null = browserStorage(),
  current: readonly RecentRun[] = [],
): RecentRun[] {
  const base = readRuns(storage) ?? current;
  const next = [run, ...base.filter((entry) => entry.sessionId !== run.sessionId)].slice(0, MAX_RECENT_RUNS);
  return writeRuns(next, storage) ?? next;
}

export function removeRecentRun(
  sessionId: string,
  storage: StorageLike | null = browserStorage(),
  current: readonly RecentRun[] = [],
): RecentRun[] {
  const base = readRuns(storage) ?? current;
  const next = base.filter((entry) => entry.sessionId !== sessionId);
  return writeRuns(next, storage) ?? next;
}

export function clearRecentRuns(storage: StorageLike | null = browserStorage()): RecentRun[] {
  try {
    storage?.removeItem(RECENT_RUNS_KEY);
  } catch {
    // Nothing more to do: the list on screen is cleared either way.
  }
  return [];
}

// ---------------------------------------------------------------------------------------------
// Display
// ---------------------------------------------------------------------------------------------

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

/** "just now", "5 min ago", "3 hours ago", "yesterday", "4 days ago", then a date. */
export function relativeTime(then: number, now: number = Date.now()): string {
  const ago = now - then;
  if (!Number.isFinite(ago) || ago < MINUTE) return "just now";
  if (ago < HOUR) return `${Math.floor(ago / MINUTE)} min ago`;
  if (ago < DAY) {
    const hours = Math.floor(ago / HOUR);
    return `${hours} ${hours === 1 ? "hour" : "hours"} ago`;
  }
  if (ago < 2 * DAY) return "yesterday";
  if (ago < 7 * DAY) return `${Math.floor(ago / DAY)} days ago`;
  return new Date(then).toLocaleDateString(undefined, { day: "numeric", month: "short", year: "numeric" });
}
