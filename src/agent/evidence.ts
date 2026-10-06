import type {
  Candidate,
  EntityRef,
  LocalFit,
  PreviewRow,
  ResolutionIssue,
  ToolResultView,
  ToolStatus,
  TrendSummary,
} from "../shared/types.js";
import type { JsonObject, QlooEnvelope } from "../qloo/types.js";
import { summarizeSeries } from "./trend.js";

type Rec = Record<string, unknown>;

const asRec = (v: unknown): Rec | undefined => (v !== null && typeof v === "object" && !Array.isArray(v) ? (v as Rec) : undefined);
const asStr = (v: unknown): string | undefined => (typeof v === "string" && v.length > 0 ? v : undefined);
const asNum = (v: unknown): number | undefined => (typeof v === "number" && Number.isFinite(v) ? v : undefined);

/**
 * `urn:entity:book` -> `book`. The bare `urn:entity` (what Qloo puts in `type` on insights results, with the real
 * type in `subtype`) says nothing, so it maps to undefined and callers fall back to a more specific field.
 */
export function normType(t: unknown): string | undefined {
  const s = asStr(t)?.trim().toLowerCase();
  if (!s || s === "urn:entity" || s === "entity") return undefined;
  const bare = s.replace(/^urn:entity:/, "");
  return bare.length > 0 && !bare.startsWith("urn:") ? bare : undefined;
}

/** The most specific entity type on a Qloo row: `subtype`, `type` or `types[]`, whichever is not the bare `urn:entity`. */
export function entityTypeOf(row: Record<string, unknown>): string | undefined {
  const types = Array.isArray(row["types"]) ? (row["types"] as unknown[]) : [];
  for (const t of [row["subtype"], row["type"], ...types]) {
    const n = normType(t);
    if (n) return n;
  }
  return undefined;
}

/** Lowercase, strip diacritics/punctuation, collapse spaces. Used to compare names across Qloo results and prose. */
export function normName(s: string): string {
  return s
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .trim();
}

/** Arguments that take entity names/ids; the model may pass a handle ("e12") there and we expand it to the Qloo id. */
const ENTITY_ARG_FIELDS = ["signals", "options", "entities", "entity", "group_a", "group_b"];
const HANDLE = /^e\d+$/;

export type Role = "input" | "result" | "option" | "group_a" | "group_b";

export interface Appearance {
  callId: string;
  tool: string;
  role: Role;
  position?: number;
  of?: number;
  affinity?: number;
  drivenBy?: string[];
}

export interface EntityRecord {
  handle: string;
  entityId: string;
  name: string;
  type?: string;
  year?: number;
  appearances: Appearance[];
}

export interface TagRecord {
  id?: string;
  name: string;
  affinity?: number;
}

export interface CallRecord {
  callId: string;
  tool: string;
  args: JsonObject;
  status: ToolStatus;
  summary: string;
  durationMs: number;
  cached: boolean;
  sample: boolean;
  envelope: QlooEnvelope;
  /** Resolved inputs reported by Qloo (signals, options, entity...). */
  resolved: { input: string; field: string; entity: EntityRecord }[];
  results: EntityRecord[];
  tags: TagRecord[];
  targetType?: string;
  trends: TrendSummary[];
  local?: LocalFit;
  view: ToolResultView;
}

export const toRef = (e: EntityRecord): EntityRef => ({
  handle: e.handle,
  entityId: e.entityId,
  name: e.name,
  ...(e.type ? { type: e.type } : {}),
  ...(e.year !== undefined ? { year: e.year } : {}),
});

const yearOf = (e: Rec): number | undefined => {
  const p = asRec(e["properties"]);
  const y = asNum(p?.["release_year"]) ?? asNum(e["release_year"]);
  return y !== undefined && Number.isInteger(y) ? y : undefined;
};

function explainNames(explain: unknown): string[] {
  const names: string[] = [];
  const walk = (v: unknown, depth: number): void => {
    if (depth > 5 || names.length >= 6) return;
    if (Array.isArray(v)) v.slice(0, 20).forEach((x) => walk(x, depth + 1));
    else if (asRec(v)) {
      const r = v as Rec;
      const n = asStr(r["name"]);
      if (n && !names.includes(n)) names.push(n);
      for (const x of Object.values(r)) if (typeof x === "object") walk(x, depth + 1);
    }
  };
  walk(explain, 0);
  return names;
}

export class EvidenceStore {
  private readonly calls: CallRecord[] = [];
  private readonly entities = new Map<string, EntityRecord>(); // handle -> record
  private readonly byKey = new Map<string, string>(); // entityId | name|type -> handle
  private readonly tagNames = new Set<string>();
  /** Names the user confirmed for an id before any result mentioned it; used only for display labels. */
  private readonly aliases = new Map<string, string>();
  private entityCounter = 0;
  private callCounter = 0;
  private numberCache: Set<string> | undefined;

  nextCallId(): string {
    this.callCounter += 1;
    return `c${this.callCounter}`;
  }

  allCalls(): readonly CallRecord[] {
    return this.calls;
  }

  call(callId: string): CallRecord | undefined {
    return this.calls.find((c) => c.callId === callId);
  }

  entity(handle: string): EntityRecord | undefined {
    return this.entities.get(handle);
  }

  allEntities(): EntityRecord[] {
    return [...this.entities.values()];
  }

  /** Get-or-create an entity by Qloo id (falls back to name+type when an id is missing). */
  private ensure(id: string | undefined, name: string, type?: string, year?: number): EntityRecord {
    const key = id ?? `${normName(name)}|${type ?? ""}`;
    const existing = this.byKey.get(key);
    if (existing) {
      const rec = this.entities.get(existing)!;
      if (!rec.type && type) rec.type = type;
      if (rec.year === undefined && year !== undefined) rec.year = year;
      return rec;
    }
    this.entityCounter += 1;
    const rec: EntityRecord = {
      handle: `e${this.entityCounter}`,
      entityId: id ?? key,
      name,
      ...(type ? { type } : {}),
      ...(year !== undefined ? { year } : {}),
      appearances: [],
    };
    this.entities.set(rec.handle, rec);
    this.byKey.set(key, rec.handle);
    return rec;
  }

  /** Expand handles in entity-valued arguments to Qloo ids. Unknown handles are reported, not guessed. */
  expandHandles(args: JsonObject): { args: JsonObject; unknown: string[] } {
    const unknown: string[] = [];
    const swap = (v: unknown): unknown => {
      if (typeof v === "string" && HANDLE.test(v.trim())) {
        const rec = this.entities.get(v.trim());
        if (!rec) {
          unknown.push(v.trim());
          return v;
        }
        return rec.entityId;
      }
      return v;
    };
    const out: JsonObject = { ...args };
    for (const field of ENTITY_ARG_FIELDS) {
      const v = out[field];
      if (Array.isArray(v)) out[field] = v.map(swap);
      else if (v !== undefined) out[field] = swap(v);
    }
    return { args: out, unknown };
  }

  /** Remember the name of a candidate the user confirmed, so the first call that uses its id is labelled by name. */
  rememberName(id: string, name: string): void {
    this.aliases.set(id, name);
  }

  /** Display name for an id/handle/name argument value. */
  nameFor(value: unknown): string {
    if (typeof value !== "string") return String(value);
    const byHandle = this.entities.get(value);
    if (byHandle) return byHandle.name;
    const byId = this.byKey.get(value);
    if (byId) return this.entities.get(byId)?.name ?? value;
    return this.aliases.get(value) ?? value;
  }

  /** Every name Qloo has returned (entities and tags), normalised. Used by the no-invention guard. */
  knownNames(): Set<string> {
    const s = new Set<string>();
    for (const e of this.entities.values()) s.add(normName(e.name));
    for (const t of this.tagNames) s.add(t);
    return s;
  }

  /** All numeric tokens appearing in any Qloo result in this session. */
  numberTokens(): Set<string> {
    if (this.numberCache) return this.numberCache;
    const s = new Set<string>();
    for (const c of this.calls) for (const m of JSON.stringify(c.envelope).match(/-?\d+(?:\.\d+)?/g) ?? []) s.add(m.replace(/^-/, ""));
    this.numberCache = s;
    return s;
  }

  // -------------------------------------------------------------------------------- ingest

  addCall(input: {
    callId: string;
    tool: string;
    args: JsonObject;
    envelope: QlooEnvelope;
    durationMs: number;
    cached: boolean;
    sample: boolean;
  }): CallRecord {
    this.numberCache = undefined;
    const { callId, tool, envelope } = input;
    const rec: CallRecord = {
      callId,
      tool,
      args: input.args,
      status: envelope.status,
      summary: envelope.summary ?? "",
      durationMs: input.durationMs,
      cached: input.cached,
      sample: input.sample,
      envelope,
      resolved: [],
      results: [],
      tags: [],
      trends: [],
      view: undefined as unknown as ToolResultView,
    };

    this.collectResolved(rec, envelope.interpretation, "");
    const interp = asRec(envelope.interpretation);
    rec.targetType = normType(interp?.["target_type"] ?? interp?.["option_type"] ?? input.args["target_type"] ?? input.args["option_type"]);

    // Roles for resolved inputs.
    for (const r of rec.resolved) {
      const role: Role = r.field === "options" ? "option" : r.field === "group_a" ? "group_a" : r.field === "group_b" ? "group_b" : "input";
      r.entity.appearances.push({ callId, tool, role });
    }

    switch (tool) {
      case "qloo_recommend":
      case "qloo_rank":
      case "qloo_describe":
        this.collectEntityResults(rec, envelope.results);
        break;
      case "qloo_compare_audiences":
        this.collectLooseEntities(rec, envelope.results);
        break;
      case "qloo_entity_tags":
      case "qloo_find_tags":
        this.collectTags(rec, envelope.results);
        break;
      case "qloo_where_popular":
        this.collectLocal(rec);
        break;
      case "qloo_trends":
        this.collectTrends(rec);
        break;
      default:
        break;
    }

    rec.view = this.buildView(rec);
    this.calls.push(rec);
    return rec;
  }

  private collectResolved(rec: CallRecord, node: unknown, field: string): void {
    if (Array.isArray(node)) {
      for (const n of node) this.collectResolved(rec, n, field);
      return;
    }
    const o = asRec(node);
    if (!o) return;
    const id = asStr(o["entityId"]);
    const name = asStr(o["name"]);
    if (id && name) {
      const entity = this.ensure(id, name, entityTypeOf(o));
      rec.resolved.push({ input: asStr(o["input"]) ?? name, field, entity });
      return;
    }
    for (const [k, v] of Object.entries(o)) if (typeof v === "object" && v !== null) this.collectResolved(rec, v, k);
  }

  private collectEntityResults(rec: CallRecord, results: unknown): void {
    const rows = Array.isArray(results) ? results : [];
    const entities: { e: EntityRecord; row: Rec }[] = [];
    for (const raw of rows) {
      const row = asRec(raw);
      if (!row) continue;
      const name = asStr(row["name"]);
      if (!name) continue;
      const id = asStr(row["entity_id"]) ?? asStr(row["id"]);
      entities.push({ e: this.ensure(id, name, entityTypeOf(row) ?? rec.targetType, yearOf(row)), row });
    }
    entities.forEach(({ e, row }, i) => {
      const query = asRec(row["query"]);
      const affinity = asNum(row["affinity"]) ?? asNum(query?.["affinity"]);
      const drivenBy = explainNames(row["explainability"]);
      e.appearances.push({
        callId: rec.callId,
        tool: rec.tool,
        role: "result",
        position: i + 1,
        of: entities.length,
        ...(affinity !== undefined ? { affinity } : {}),
        ...(drivenBy.length ? { drivenBy } : {}),
      });
      rec.results.push(e);
    });
  }

  /** compare_audiences results have no documented shape: collect any entity-like objects, in order. */
  private collectLooseEntities(rec: CallRecord, results: unknown): void {
    const found: { e: EntityRecord; affinity?: number }[] = [];
    const walk = (v: unknown, depth: number): void => {
      if (depth > 6 || found.length >= 40) return;
      if (Array.isArray(v)) return v.forEach((x) => walk(x, depth + 1));
      const o = asRec(v);
      if (!o) return;
      const name = asStr(o["name"]);
      const id = asStr(o["entity_id"]) ?? asStr(o["id"]);
      if (name && id) {
        const q = asRec(o["query"]);
        const affinity = asNum(o["affinity"]) ?? asNum(q?.["affinity"]);
        found.push({ e: this.ensure(id, name, entityTypeOf(o) ?? rec.targetType, yearOf(o)), ...(affinity !== undefined ? { affinity } : {}) });
        return;
      }
      for (const x of Object.values(o)) if (typeof x === "object") walk(x, depth + 1);
    };
    walk(results, 0);
    found.forEach(({ e, affinity }, i) => {
      e.appearances.push({ callId: rec.callId, tool: rec.tool, role: "result", position: i + 1, of: found.length, ...(affinity !== undefined ? { affinity } : {}) });
      rec.results.push(e);
    });
  }

  private collectTags(rec: CallRecord, results: unknown): void {
    for (const raw of Array.isArray(results) ? results : []) {
      const t = asRec(raw);
      const name = t && asStr(t["name"]);
      if (!t || !name) continue;
      const q = asRec(t["query"]);
      const affinity = asNum(t["affinity"]) ?? asNum(q?.["affinity"]);
      rec.tags.push({ name, ...(asStr(t["id"]) ? { id: asStr(t["id"]) as string } : {}), ...(affinity !== undefined ? { affinity } : {}) });
      this.tagNames.add(normName(name));
    }
  }

  private collectLocal(rec: CallRecord): void {
    const interp = asRec(rec.envelope.interpretation);
    const entity = rec.resolved.find((r) => r.field === "entity")?.entity;
    const within = asStr(interp?.["within"]) ?? asStr(rec.args["within"]) ?? "the requested area";
    const points = Array.isArray(rec.envelope.results) ? rec.envelope.results : [];
    if (!entity) return;
    const affinities = points
      .map((p) => asNum(asRec(asRec(p)?.["query"])?.["affinity"]) ?? asNum(asRec(p)?.["affinity"]))
      .filter((n): n is number => n !== undefined);
    const topAffinity = affinities.length ? Math.max(...affinities) : undefined;
    rec.local = {
      callId: rec.callId,
      entity: toRef(entity),
      within,
      areas: points.length,
      ...(topAffinity !== undefined ? { topAffinity } : {}),
      summary:
        points.length === 0
          ? `Qloo returned no areas within ${within} for this title.`
          : `Qloo returned ${points.length} area${points.length === 1 ? "" : "s"} within ${within}` +
            (topAffinity !== undefined ? `; the strongest has affinity ${topAffinity}.` : "."),
    };
  }

  private collectTrends(rec: CallRecord): void {
    const interp = asRec(rec.envelope.interpretation);
    const start = asStr(interp?.["start_date"]) ?? asStr(rec.args["start_date"]);
    const end = asStr(interp?.["end_date"]) ?? asStr(rec.args["end_date"]);
    for (const raw of Array.isArray(rec.envelope.series) ? rec.envelope.series : []) {
      const s = asRec(raw);
      const ent = asRec(s?.["entity"]);
      const id = asStr(ent?.["entityId"]);
      const name = asStr(ent?.["name"]);
      if (!s || !ent || !name) continue;
      const entity = this.ensure(id, name, entityTypeOf(ent) ?? rec.targetType);
      entity.appearances.push({ callId: rec.callId, tool: rec.tool, role: "input" });
      const sum = summarizeSeries(Array.isArray(s["points"]) ? (s["points"] as unknown[]) : []);
      rec.trends.push({
        callId: rec.callId,
        entity: toRef(entity),
        direction: sum.direction,
        basis: sum.basis,
        ...(start ? { startDate: start } : {}),
        ...(end ? { endDate: end } : {}),
        points: sum.points,
      });
    }
  }

  // -------------------------------------------------------------------------------- views

  private buildView(rec: CallRecord): ToolResultView {
    const env = rec.envelope;
    const preview: PreviewRow[] = [];
    if (rec.results.length) {
      rec.results.slice(0, 10).forEach((e) => {
        const a = e.appearances.find((x) => x.callId === rec.callId && x.role === "result");
        preview.push({
          handle: e.handle,
          name: e.name,
          ...(e.type ? { type: e.type } : {}),
          ...(e.year !== undefined ? { year: e.year } : {}),
          ...(a?.affinity !== undefined ? { affinity: a.affinity } : {}),
          ...(a?.position ? { detail: `result ${a.position} of ${a.of}` } : {}),
        });
      });
    } else if (rec.tags.length) {
      rec.tags.slice(0, 10).forEach((t) => preview.push({ name: t.name, type: "tag", ...(t.affinity !== undefined ? { affinity: t.affinity } : {}) }));
    } else if (rec.trends.length) {
      rec.trends.forEach((t) => preview.push({ handle: t.entity.handle, name: t.entity.name, detail: `trend: ${t.direction}` }));
    } else if (rec.local) {
      preview.push({ handle: rec.local.entity.handle, name: rec.local.entity.name, detail: rec.local.summary });
    }
    const requests = (env.provenance?.requests ?? []).slice(0, 20).map((r) => ({ path: r.path, query: r.query }));
    const err = env.error;
    return {
      callId: rec.callId,
      tool: rec.tool,
      status: rec.status,
      summary: rec.summary || defaultSummary(rec),
      durationMs: rec.durationMs,
      cached: rec.cached,
      sample: rec.sample,
      resolved: rec.resolved.map((r) => ({ input: r.input, entity: toRef(r.entity) })),
      requests,
      resultCount: rec.results.length || rec.tags.length || rec.trends.length || (rec.local?.areas ?? 0) || (typeof env.result_count === "number" ? env.result_count : 0),
      preview,
      ...(rec.trends.length ? { trend: rec.trends } : {}),
      ...(rec.local ? { local: rec.local } : {}),
      warnings: Array.isArray(env.warnings) ? env.warnings.filter((w): w is string => typeof w === "string") : [],
      ...(err ? { error: { code: err.code, retryable: err.retryable, recovery: err.recovery } } : {}),
      raw: env,
    };
  }

  // -------------------------------------------------------------------------------- needs_input

  issuesFor(callId: string, envelope: QlooEnvelope): ResolutionIssue[] {
    const res = asRec(envelope.resolution);
    const raw = Array.isArray(res?.["issues"]) ? (res?.["issues"] as unknown[]) : [];
    const issues: ResolutionIssue[] = [];
    raw.forEach((r, i) => {
      const o = asRec(r);
      if (!o) return;
      const kind = o["kind"] === "ambiguous" ? "ambiguous" : "not_found";
      const candidates: Candidate[] = (Array.isArray(o["candidates"]) ? (o["candidates"] as unknown[]) : []).flatMap((c) => {
        const cr = asRec(c);
        const id = cr && asStr(cr["id"]);
        const name = cr && asStr(cr["name"]);
        if (!cr || !id || !name) return [];
        const year = asNum(cr["release_year"]);
        return [
          {
            id,
            name,
            ...(entityTypeOf(cr) ? { type: entityTypeOf(cr) as string } : {}),
            ...(asStr(cr["description"]) ? { description: (asStr(cr["description"]) as string).slice(0, 240) } : {}),
            ...(year !== undefined ? { releaseYear: year } : {}),
            ...(asNum(cr["popularity"]) !== undefined ? { popularity: asNum(cr["popularity"]) as number } : {}),
          },
        ];
      });
      issues.push({
        issueId: `${callId}.${i}`,
        input: asStr(o["input"]) ?? "(unnamed input)",
        kind: kind === "ambiguous" && candidates.length > 0 ? "ambiguous" : "not_found",
        inputKind: o["input_kind"] === "tag" ? "tag" : "entity",
        field: asStr(o["field"]) ?? "",
        candidates,
      });
    });
    return issues;
  }

  // -------------------------------------------------------------------------------- queries for the report

  /** Calls (recommend/rank/compare) in which `loved` was an input and `book` came back as a result. */
  supportingCalls(loved: EntityRecord, book: EntityRecord): { call: CallRecord; appearance: Appearance }[] {
    const out: { call: CallRecord; appearance: Appearance }[] = [];
    for (const c of this.calls) {
      if (c.tool !== "qloo_recommend" && c.tool !== "qloo_rank" && c.tool !== "qloo_compare_audiences") continue;
      if (c.status === "error" || c.status === "needs_input") continue;
      const lovedIn = c.resolved.some((r) => r.entity.handle === loved.handle && r.field !== "options");
      if (!lovedIn) continue;
      const a = book.appearances.find((x) => x.callId === c.callId && x.role === "result");
      if (a) out.push({ call: c, appearance: a });
    }
    return out;
  }

  /** Was this entity ever supplied as a signal/input (i.e. something patrons love), as opposed to only a result? */
  isInput(e: EntityRecord): boolean {
    return e.appearances.some((a) => a.role === "input" || a.role === "group_a" || a.role === "group_b");
  }

  /** Was this entity returned as a book? */
  isBook(e: EntityRecord): boolean {
    if (e.type === "book") return true;
    return e.appearances.some((a) => {
      if (a.role !== "result" && a.role !== "option") return false;
      return this.call(a.callId)?.targetType === "book";
    });
  }
}

/** The harness sends no `summary` on successful results, so most live calls are summarised here. */
function defaultSummary(rec: CallRecord): string {
  switch (rec.status) {
    case "empty":
      return "Qloo returned no matches.";
    case "error":
      return "The call failed.";
    default: {
      if (rec.local) return rec.local.summary;
      const op = rec.tool.replace(/^qloo_/, "");
      if (rec.trends.length) {
        const known = rec.trends.filter((t) => t.direction !== "unknown").length;
        return `${op} returned ${rec.trends.length} series; Shelfwise could read a direction for ${known} of them.`;
      }
      const reported = typeof rec.envelope.result_count === "number" ? rec.envelope.result_count : 0;
      const n = rec.results.length || rec.tags.length || reported;
      return `${op} returned ${n} item${n === 1 ? "" : "s"}.`;
    }
  }
}

// ------------------------------------------------------------------------------------------------
// What the model sees: a compact digest of each tool result, with handles ("ref") it can cite.
// ------------------------------------------------------------------------------------------------

const MAX_ROWS = 12;

export function digestFor(rec: CallRecord, extraNotes: string[] = []): string {
  const out: Rec = {
    call: rec.callId,
    tool: rec.tool,
    status: rec.status,
    summary: rec.summary,
  };
  if (rec.cached) out["cached"] = true;
  if (rec.resolved.length) {
    out["resolved_inputs"] = rec.resolved.map((r) => ({
      input: r.input,
      ref: r.entity.handle,
      name: r.entity.name,
      ...(r.entity.type ? { type: r.entity.type } : {}),
      id: r.entity.entityId,
    }));
  }
  if (rec.results.length) {
    out["results"] = rec.results.slice(0, MAX_ROWS).map((e) => {
      const a = e.appearances.find((x) => x.callId === rec.callId && x.role === "result");
      return {
        ref: e.handle,
        name: e.name,
        ...(e.type ? { type: e.type } : {}),
        ...(e.year !== undefined ? { year: e.year } : {}),
        id: e.entityId,
        position: a?.position,
        ...(a?.affinity !== undefined ? { affinity: a.affinity } : {}),
        ...(a?.drivenBy?.length ? { driven_by: a.drivenBy } : {}),
      };
    });
  }
  if (rec.tags.length) out["tags"] = rec.tags.slice(0, MAX_ROWS);
  if (rec.local) out["local_fit"] = { within: rec.local.within, areas: rec.local.areas, top_affinity: rec.local.topAffinity };
  if (rec.trends.length) out["trends"] = rec.trends.map((t) => ({ ref: t.entity.handle, name: t.entity.name, direction: t.direction, basis: t.basis }));
  const warnings = (rec.envelope.warnings ?? []).concat(extraNotes);
  if (warnings.length) out["warnings"] = warnings;
  if (rec.envelope.error) out["error"] = rec.envelope.error;
  if (rec.tool === "qloo_audience_demographics" || (rec.tool === "qloo_compare_audiences" && rec.results.length === 0)) {
    out["raw_excerpt"] = JSON.stringify(rec.envelope.results).slice(0, 2500);
  }
  let text = JSON.stringify(out);
  if (text.length > 9000) {
    out["results"] = (out["results"] as unknown[] | undefined)?.slice(0, 6);
    out["truncated"] = true;
    text = JSON.stringify(out);
  }
  return text;
}

// ------------------------------------------------------------------------------------------------
// Human label for a tool call, for the evidence trail.
// ------------------------------------------------------------------------------------------------

export function labelFor(tool: string, args: JsonObject, store: EvidenceStore): string {
  const names = (v: unknown): string => (Array.isArray(v) ? v.map((x) => store.nameFor(x)).join(", ") : v === undefined ? "" : store.nameFor(v));
  const type = String(args["target_type"] ?? args["option_type"] ?? args["entity_type"] ?? "").replace(/_/g, " ");
  switch (tool) {
    case "qloo_recommend": {
      const bits = [`Recommend ${type || "entities"}`];
      if (args["signals"]) bits.push(`for fans of ${names(args["signals"])}`);
      if (args["signal_tags"]) bits.push(`matching ${names(args["signal_tags"])}`);
      if (args["signal_location"]) bits.push(`near ${String(args["signal_location"])}`);
      if (args["demographic"]) bits.push(`(audience: ${String(args["demographic"])})`);
      return bits.join(" ");
    }
    case "qloo_rank":
      return `Rank ${Array.isArray(args["options"]) ? args["options"].length : ""} ${type || "options"}${args["signals"] ? ` for ${names(args["signals"])}` : ""}${args["demographic"] ? ` (audience: ${String(args["demographic"])})` : ""}`.replace(/\s+/g, " ");
    case "qloo_where_popular":
      return `Where is ${names(args["entity"])} popular within ${String(args["within"] ?? "the area")}`;
    case "qloo_trends":
      return `Trend for ${names(args["entities"])} (${String(args["start_date"] ?? "")} to ${String(args["end_date"] ?? "")})`;
    case "qloo_compare_audiences":
      return `Compare fans of ${names(args["group_a"])} with fans of ${names(args["group_b"])}`;
    case "qloo_describe":
      return `Look up ${names(args["entity"])}`;
    case "qloo_find_tags":
      return `Find Qloo tags for “${String(args["query"] ?? "")}”`;
    case "qloo_entity_tags":
      return `Tags that describe ${names(args["entities"])}`;
    case "qloo_audience_demographics":
      return `Audience profile of ${names(args["entity"])}`;
    default:
      return tool;
  }
}
