/**
 * Contract shared by the Shelfwise server and the web client.
 *
 * Everything here is plain data (JSON-serialisable). The server streams `AgentEvent`s to the browser
 * over Server-Sent Events; the browser renders them. Nothing in this file may ever carry a secret.
 *
 * Provenance rule (enforced server-side in src/agent/guard.ts): every title, score, rank, local-fit and
 * trend value in a `Report` is joined from a Qloo tool result by the server. The language model only writes
 * short prose (`why`, `rationale`, programme text) and chooses *which* returned entities to feature.
 */

// ---------------------------------------------------------------------------------------------
// Constants (the only runtime values in this file)
// ---------------------------------------------------------------------------------------------

/** One-line statement of limits shown in the UI. */
export const LIMITS_LINE =
  "Shelfwise shows aggregate taste affinities from Qloo, not information about individual patrons.";

/** Shown whenever sample (fixture) data is in use. Must stay visible in the UI and on printed shelf-talkers. */
export const SAMPLE_DATA_LABEL = "Sample data — not live Qloo results";

/**
 * Audience age bands offered in the form. Qloo can only condition on its own age buckets
 * (24 and younger, 25-29, 30-34, 35-44, 45-54, 55 and older) - there is no finer "teens" or "children" band.
 * `demographic` is the exact natural-language phrase passed to qloo_recommend / qloo_rank.
 */
export const AGE_BANDS = [
  { id: "any", label: "Whole community (no age focus)", demographic: null, note: null },
  {
    id: "teens",
    label: "Teens and young adults",
    demographic: "teens",
    note: "Qloo’s youngest audience band is “24 and younger”; it cannot separate children or teens from 18–24s.",
  },
  { id: "25-34", label: "25–34", demographic: "25-34", note: null },
  { id: "35-54", label: "35–54", demographic: "35-54", note: null },
  { id: "55plus", label: "55 and over", demographic: "over 55", note: null },
] as const;

export type AgeBandId = (typeof AGE_BANDS)[number]["id"];

// ---------------------------------------------------------------------------------------------
// Requests
// ---------------------------------------------------------------------------------------------

export interface FormInput {
  /** City / region. Required. Passed to Qloo as a location signal. */
  place: string;
  ageBand: AgeBandId;
  /** Free text: shows, films, artists, games, podcasts, books patrons are into right now. Max 600 chars. */
  interests: string;
  /** How many titles to buy or feature (3-20). */
  titleCount: number;
  /** Optional budget, same currency as avgPrice. Only used with avgPrice, and only for arithmetic shown to the user. */
  budget?: number;
  /** Optional average price per title, supplied by the user (Qloo returns no prices). */
  avgPrice?: number;
}

/** The user's answer to one ambiguity the agent asked about. `pick: null` means "skip this one". */
export interface ResolutionChoice {
  issueId: string;
  pick: Candidate | null;
}

/** POST /api/runs. Responds with an SSE stream of AgentEvent. */
export type RunRequest =
  | { sessionId?: undefined; input: { kind: "form"; form: FormInput } }
  | { sessionId: string; input: { kind: "message"; text: string } }
  | { sessionId: string; input: { kind: "resolution"; choices: ResolutionChoice[] } };

/** Non-SSE failures (400, 404, 409, 429, 503...) return this JSON body. */
export interface ApiError {
  error: { code: string; message: string; retryAfterSec?: number };
}

// ---------------------------------------------------------------------------------------------
// Health
// ---------------------------------------------------------------------------------------------

export interface HealthResponse {
  ok: boolean;
  /** "fixtures" = sample data. The UI must show SAMPLE_DATA_LABEL prominently in this mode. */
  mode: "live" | "fixtures";
  /** False when a live-mode key is missing, etc. `problems` says what. Runs are refused (never faked) when false. */
  ready: boolean;
  problems: string[];
  llm: { provider: string; model: string; scripted: boolean };
  qloo: { sample: boolean; mcpUp: boolean | null };
  limitsLine: string;
  limits: { maxSteps: number; maxToolCalls: number; runsPerHour: number; messagesPerHour: number; maxConcurrentRuns: number };
  /** Only in fixtures mode: inputs the sample dataset can answer, so the UI can offer "try a sample". */
  sampleInputs: FormInput[];
}

/** GET /healthz - for the reverse proxy / orchestrator. */
export interface Healthz {
  ok: boolean;
  mode: "live" | "sample-data";
  /** null when the MCP child is not used (sample-data mode). */
  mcp: { up: boolean; restarts: number } | null;
}

// ---------------------------------------------------------------------------------------------
// Qloo evidence, as shown in the evidence trail
// ---------------------------------------------------------------------------------------------

export type ToolStatus = "ok" | "empty" | "needs_input" | "partial" | "degraded" | "error";

export interface EntityRef {
  /** Server-assigned handle, stable within a session ("e12"). */
  handle: string;
  /** Qloo entity id. */
  entityId: string;
  name: string;
  /** Qloo entity type: "book", "tv_show", "artist", ... */
  type?: string;
  year?: number;
}

export interface Candidate {
  id: string;
  name: string;
  type?: string;
  description?: string;
  releaseYear?: number;
  popularity?: number;
}

export interface ResolutionIssue {
  /** "<callId>.<n>", pass back in ResolutionChoice. */
  issueId: string;
  /** What the user typed or the agent asked for. */
  input: string;
  /** ambiguous: pick one of `candidates`. not_found: nothing matched; the user can only skip or rephrase. */
  kind: "ambiguous" | "not_found";
  inputKind: "entity" | "tag";
  /** Which tool argument it came from, e.g. "signals". */
  field: string;
  candidates: Candidate[];
}

export interface PreviewRow {
  handle?: string;
  name: string;
  type?: string;
  year?: number;
  /** Qloo affinity exactly as returned (scale as returned by Qloo). Not comparable across different calls. */
  affinity?: number;
  /** Short extra, e.g. "rank 3 of 8" or "area 2". */
  detail?: string;
}

export type TrendDirection = "rising" | "fading" | "steady" | "unknown";

/** Direction is computed by Shelfwise from the series Qloo returned; `basis` says how. */
export interface TrendSummary {
  callId: string;
  entity: EntityRef;
  direction: TrendDirection;
  basis: string;
  startDate?: string;
  endDate?: string;
  points: number;
}

export interface LocalFit {
  callId: string;
  entity: EntityRef;
  within: string;
  areas: number;
  /** Highest affinity among the returned areas, as returned by Qloo. */
  topAffinity?: number;
  summary: string;
}

export interface ToolCallView {
  /** "c1", "c2", ... unique within a session. */
  callId: string;
  tool: string;
  /** Arguments as sent to Qloo (after validation). Never contains secrets. */
  args: Record<string, unknown>;
  /** Plain-English one-liner, e.g. "Recommend books for fans of Severance near Newark, NJ". */
  label: string;
}

export interface ToolResultView {
  callId: string;
  tool: string;
  status: ToolStatus;
  summary: string;
  durationMs: number;
  /** Served from Shelfwise's response cache (no Qloo call made). */
  cached: boolean;
  /** True when this result came from the placeholder fixtures, not Qloo. */
  sample: boolean;
  /** Entities Qloo resolved the inputs to (names + ids), as reported in the result. */
  resolved: { input: string; entity: EntityRef }[];
  /** The Qloo API requests the harness reports it made. */
  requests: { path: string; query: unknown }[];
  resultCount: number;
  preview: PreviewRow[];
  trend?: TrendSummary[];
  local?: LocalFit;
  warnings: string[];
  error?: { code: string; retryable: boolean; recovery: string };
  /** The full Qloo envelope, for the "raw result" expander. */
  raw: unknown;
}

// ---------------------------------------------------------------------------------------------
// Report (the three artefacts)
// ---------------------------------------------------------------------------------------------

/** A pointer from a displayed claim to the tool call that supports it. */
export interface Cite {
  callId: string;
  tool: string;
  /** e.g. "affinity 0.83, result 2 of 8" - values copied from the Qloo result. */
  label: string;
}

export interface BuyEvidence {
  /** Signals whose own recommend call returned this title. */
  matchedSignals: EntityRef[];
  recommendations: { callId: string; signal?: EntityRef; position: number; of: number; affinity?: number }[];
  /** Position in the audience rank call. Scores from different calls are not comparable. */
  rank?: { callId: string; position: number; of: number; affinity?: number };
  localFit?: LocalFit;
  trend?: TrendSummary;
  /** True when any supporting call came back partial or degraded. */
  reduced: boolean;
}

export interface BridgeCard {
  id: string;
  /** What patrons already love (resolved Qloo entities). "Loved [loved]? Try [book]." */
  loved: EntityRef[];
  book: EntityRef;
  /** One line, model-written, placeholders already expanded to returned titles. */
  why: string;
  cites: Cite[];
  reduced: boolean;
}

export interface BuyItem {
  rank: number;
  book: EntityRef;
  rationale: string;
  evidence: BuyEvidence;
  cites: Cite[];
}

export type ProgrammeKind = "film_night" | "themed_display" | "book_club" | "other";

export interface ProgrammeIdea {
  id: string;
  kind: ProgrammeKind;
  title: string;
  description: string;
  books: EntityRef[];
  /** Screen / music / game signals the idea builds on. */
  signals: EntityRef[];
  cites: Cite[];
}

export interface ReportNote {
  kind: "guard" | "reduced" | "gap" | "info";
  text: string;
}

export interface Report {
  /** Increments each time the agent re-submits (follow-ups). */
  version: number;
  createdAt: string;
  /** True when any data in this report came from sample fixtures. */
  sample: boolean;
  place: string;
  audience: string;
  bridgeShelf: BridgeCard[];
  buyList: BuyItem[];
  programmes: ProgrammeIdea[];
  notes: ReportNote[];
  /** User-supplied arithmetic only, e.g. "$400 / $18 per title = 22 titles". Absent unless both numbers were given. */
  budgetNote?: string;
}

// ---------------------------------------------------------------------------------------------
// SSE events (POST /api/runs). Each SSE message is `event: <type>` + `data: <JSON of the event>`.
// ---------------------------------------------------------------------------------------------

export interface PlanStep {
  title: string;
  /** Qloo tool the step expects to use (optional). The UI ticks a step when a matching call completes. */
  tool?: string;
}

export type DoneReason = "completed" | "awaiting_input" | "max_steps" | "error" | "aborted";

export type AgentEvent =
  | { type: "session"; sessionId: string; runId: string; mode: "live" | "fixtures" }
  /** The run is waiting for a free agent slot. `position` 1 = next. Emitted again when it changes. */
  | { type: "queued"; position: number; ahead: number }
  | { type: "started" }
  | { type: "plan"; steps: PlanStep[] }
  /** Short narration from the model while it works. Plain text. */
  | { type: "note"; text: string }
  | { type: "tool_call"; call: ToolCallView }
  | { type: "tool_result"; result: ToolResultView }
  | { type: "retry"; callId: string; attempt: number; delayMs: number; reason: string }
  /** The run pauses (followed by `done` with reason "awaiting_input"); continue with a `resolution` request. */
  | { type: "needs_input"; callId: string; tool: string; message: string; issues: ResolutionIssue[] }
  | { type: "report"; report: Report }
  /** Free-text assistant reply (answers that do not change the report). */
  | { type: "message"; text: string }
  | { type: "error"; code: string; message: string; retryable: boolean }
  | { type: "done"; reason: DoneReason; steps: number; toolCalls: number };
