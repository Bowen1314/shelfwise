import type { CallOptions, JsonObject, QlooEnvelope, QlooToolClient, ToolDef } from "../types.js";
import { syntheticError } from "../types.js";
import { SAMPLE_BOOKS, SAMPLE_PLACES, SAMPLE_SIGNALS, SAMPLE_TAGS, type SampleBook } from "./data.js";
import { TOOLS_SNAPSHOT } from "./tools.snapshot.js";

/**
 * PLACEHOLDER Qloo client for DEMO_FIXTURES=1. Returns envelopes in the real result shape built from the
 * invented data in ./data.ts. It is only ever constructed when DEMO_FIXTURES is explicitly set; live mode never
 * falls back to it. Every envelope is stamped `fixture: true` and carries the sample-data label.
 */
export const SAMPLE_LABEL = "Sample data — not live Qloo results";

interface Ent {
  id: string;
  name: string;
  type: string;
  year?: number;
  book?: SampleBook;
  signalKey?: string;
}

const norm = (s: string): string =>
  s
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .trim();

const UNIVERSE: Ent[] = [
  ...SAMPLE_SIGNALS.map((s): Ent => ({ id: s.id, name: s.name, type: s.type, ...(s.year ? { year: s.year } : {}), signalKey: s.key })),
  ...SAMPLE_BOOKS.map((b): Ent => ({ id: `sample-book-${b.slug}`, name: b.name, type: "book", year: b.year, book: b })),
];

const urn = (t: string): string => `urn:entity:${t}`;

type Resolution = { status: "resolved"; entity: Ent } | { status: "ambiguous"; candidates: Ent[] } | { status: "not_found" };

function resolve(input: string, typeHint?: string): Resolution {
  const byId = UNIVERSE.find((e) => e.id === input);
  if (byId) return { status: "resolved", entity: byId };
  const n = norm(input);
  let matches = UNIVERSE.filter((e) => norm(e.name) === n);
  if (typeHint) {
    const typed = matches.filter((e) => e.type === typeHint);
    if (typed.length) matches = typed;
  }
  if (matches.length === 1) return { status: "resolved", entity: matches[0]! };
  if (matches.length > 1) return { status: "ambiguous", candidates: matches.slice(0, 5) };
  return { status: "not_found" };
}

function candidate(e: Ent, rank: number): JsonObject {
  return { id: e.id, name: e.name, type: urn(e.type), rank, score: Number((1 - rank * 0.05).toFixed(2)), ...(e.year ? { release_year: e.year } : {}) };
}

function issueFor(input: string, field: string, r: Resolution, kind: "entity" | "tag"): JsonObject {
  return {
    input,
    kind: r.status === "ambiguous" ? "ambiguous" : "not_found",
    input_kind: kind,
    field,
    ...(r.status === "ambiguous" ? { candidates: r.candidates.map((c, i) => candidate(c, i + 1)) } : {}),
  };
}

const placeOf = (loc: unknown) => (typeof loc === "string" ? SAMPLE_PLACES[norm(loc)] : undefined);

function scoreBook(book: SampleBook, signalKeys: string[], opts: { teens: boolean; placeBoost: number }): number | undefined {
  const present = signalKeys.map((k) => book.aff[k]).filter((v): v is number => v !== undefined);
  if (signalKeys.length && present.length === 0) return undefined;
  const base = signalKeys.length ? present.reduce((a, b) => a + b, 0) / signalKeys.length : 0.3;
  const boosted = base * (opts.teens && book.ya ? 1.25 : 1) + opts.placeBoost;
  return Number(Math.min(0.99, boosted).toFixed(2));
}

function compact(e: Ent, affinity?: number): JsonObject {
  return {
    entity_id: e.id,
    name: e.name,
    type: urn(e.type),
    popularity: 0.5,
    ...(affinity !== undefined ? { affinity } : {}),
    properties: e.year ? { release_year: e.year } : {},
  };
}

function matchesTag(book: SampleBook, tag: string): boolean {
  const t = norm(tag);
  return book.tags.some((x) => norm(x) === t) || (t === "translated fiction" && !!book.translated) || (t === "young adult" && !!book.ya);
}

const sleep = (ms: number, signal?: AbortSignal): Promise<void> =>
  new Promise((resolve) => {
    if (ms <= 0 || signal?.aborted) return resolve();
    const t = setTimeout(resolve, ms);
    signal?.addEventListener("abort", () => (clearTimeout(t), resolve()), { once: true });
  });

export class FixtureQlooClient implements QlooToolClient {
  private counter = 0;
  constructor(private readonly latencyMs = 250) {}

  isUp(): null {
    return null;
  }
  restarts(): number {
    return 0;
  }
  async close(): Promise<void> {}
  async listTools(): Promise<ToolDef[]> {
    return TOOLS_SNAPSHOT;
  }
  async readiness(): Promise<{ ready: boolean; detail?: string }> {
    return { ready: true, detail: SAMPLE_LABEL };
  }

  private envelope(operation: string, path: string, query: JsonObject, payload: JsonObject, started: number): QlooEnvelope {
    this.counter += 1;
    const warnings = [SAMPLE_LABEL, ...(Array.isArray(payload["warnings"]) ? (payload["warnings"] as string[]) : [])];
    return {
      schema_version: "1.0-preview.1",
      operation,
      fixture: true,
      status: "ok",
      ...payload,
      warnings,
      execution: { transport: "fixture", transport_name: "Shelfwise sample fixtures (PLACEHOLDER)", correlation_id: `fixture-${this.counter}`, duration_ms: Date.now() - started },
      provenance: { source: SAMPLE_LABEL, endpoint: path, documentation: "https://docs.qloo.com", requests: [{ method: "GET", path, query }] },
    } as QlooEnvelope;
  }

  private needsInput(operation: string, path: string, issues: JsonObject[], started: number, message = "Choose or correct the unresolved Qloo inputs."): QlooEnvelope {
    return this.envelope(operation, path, {}, { status: "needs_input", summary: message, resolution: { issues }, results: [] }, started);
  }

  async call(name: string, args: JsonObject, opts: CallOptions = {}): Promise<QlooEnvelope> {
    const started = Date.now();
    await sleep(this.latencyMs, opts.signal);
    const op = name.replace(/^qloo_/, "");
    switch (name) {
      case "qloo_recommend":
        return this.recommend(args, started);
      case "qloo_rank":
        return this.rank(args, started);
      case "qloo_describe":
        return this.describe(args, started);
      case "qloo_where_popular":
        return this.wherePopular(args, started);
      case "qloo_trends":
        return this.trends(args, started);
      case "qloo_compare_audiences":
        return this.compare(args, started);
      case "qloo_entity_tags":
        return this.entityTags(args, started);
      case "qloo_find_tags":
        return this.findTags(args, started);
      case "qloo_audience_demographics":
        return this.envelope(op, "/v2/insights", {}, { status: "empty", summary: "The sample dataset has no demographic profiles.", results: [], result_count: 0 }, started);
      default:
        return syntheticError(op, "UNKNOWN_TOOL", `Unknown tool ${name}`, false, "Use a tool from tools/list.");
    }
  }

  // ------------------------------------------------------------------------------------------------

  private resolveMany(inputs: unknown, field: string, typeHint?: string): { ents: { input: string; entity: Ent }[]; issues: JsonObject[] } {
    const ents: { input: string; entity: Ent }[] = [];
    const issues: JsonObject[] = [];
    for (const raw of Array.isArray(inputs) ? inputs : inputs === undefined ? [] : [inputs]) {
      const input = String(raw);
      const r = resolve(input, typeHint);
      if (r.status === "resolved") ents.push({ input, entity: r.entity });
      else issues.push(issueFor(input, field, r, "entity"));
    }
    return { ents, issues };
  }

  private resolveTags(inputs: unknown, field: string): { tags: string[]; issues: JsonObject[] } {
    const tags: string[] = [];
    const issues: JsonObject[] = [];
    for (const raw of Array.isArray(inputs) ? inputs : []) {
      const input = String(raw);
      const hit = SAMPLE_TAGS.find((t) => norm(t) === norm(input));
      if (hit) tags.push(hit);
      else issues.push({ input, kind: "not_found", input_kind: "tag", field });
    }
    return { tags, issues };
  }

  private interpreted(ents: { input: string; entity: Ent }[]): JsonObject[] {
    return ents.map(({ input, entity }) => ({ input, entityId: entity.id, name: entity.name, type: urn(entity.type), match: "exact" }));
  }

  private recommend(args: JsonObject, started: number): QlooEnvelope {
    const path = "/v2/insights";
    if (args["target_type"] !== "book") {
      return this.envelope("recommend", path, args, { status: "empty", summary: "The sample dataset only models books as results.", results: [], result_count: 0 }, started);
    }
    const sig = this.resolveMany(args["signals"], "signals");
    const incl = this.resolveTags(args["include_tags"], "include_tags");
    const excl = this.resolveTags(args["exclude_tags"], "exclude_tags");
    const issues = [...sig.issues, ...incl.issues, ...excl.issues];
    if (issues.length) return this.needsInput("recommend", path, issues, started);

    const place = placeOf(args["signal_location"]);
    const teens = typeof args["demographic"] === "string" && /teen|gen z|young/i.test(args["demographic"]);
    const keys = sig.ents.map((e) => e.entity.signalKey).filter((k): k is string => !!k);
    const limit = typeof args["limit"] === "number" ? args["limit"] : 10;
    const scored = SAMPLE_BOOKS.flatMap((book) => {
      if (incl.tags.length && !incl.tags.some((t) => matchesTag(book, t))) return [];
      if (excl.tags.some((t) => matchesTag(book, t))) return [];
      const s = scoreBook(book, keys, { teens, placeBoost: place?.boost[book.slug] ?? 0 });
      return s === undefined ? [] : [{ book, s }];
    })
      .sort((a, b) => b.s - a.s)
      .slice(0, limit);
    const results = scored.map(({ book, s }) => compact({ id: `sample-book-${book.slug}`, name: book.name, type: "book", year: book.year }, s));
    const partial = !!args["signal_location"] && !place;
    return this.envelope(
      "recommend",
      path,
      args,
      {
        status: results.length === 0 ? "empty" : partial ? "partial" : "ok",
        summary: results.length === 0 ? "No sample books matched these signals and filters." : `Found ${results.length} sample books.`,
        interpretation: {
          target_type: "book",
          signals: this.interpreted(sig.ents),
          ...(args["signal_location"] ? { signal_location: args["signal_location"] } : {}),
          ...(args["demographic"] ? { demographic: { input: args["demographic"] } } : {}),
        },
        results,
        result_count: results.length,
        ...(partial ? { warnings: ["Sample data models local variation only for Newark, NJ and Austin, TX; no local adjustment was applied for this place."] } : {}),
      },
      started,
    );
  }

  private rank(args: JsonObject, started: number): QlooEnvelope {
    const path = "/v2/insights";
    const opts = this.resolveMany(args["options"], "options", "book");
    const sig = this.resolveMany(args["signals"], "signals");
    const issues = [...opts.issues, ...sig.issues];
    if (issues.length) return this.needsInput("rank", path, issues, started);
    const place = placeOf(args["signal_location"]);
    const teens = typeof args["demographic"] === "string" && /teen|gen z|young/i.test(args["demographic"]);
    const keys = sig.ents.map((e) => e.entity.signalKey).filter((k): k is string => !!k);
    const ranked = opts.ents
      .flatMap(({ entity }) => (entity.book ? [{ entity, s: scoreBook(entity.book, keys, { teens, placeBoost: place?.boost[entity.book.slug] ?? 0 }) ?? 0.1 }] : []))
      .sort((a, b) => b.s - a.s);
    return this.envelope(
      "rank",
      path,
      args,
      {
        status: ranked.length ? "ok" : "empty",
        summary: `Ranked ${ranked.length} sample books.`,
        interpretation: { option_type: "book", options: this.interpreted(opts.ents), signals: this.interpreted(sig.ents) },
        results: ranked.map((r) => compact(r.entity, r.s)),
        result_count: ranked.length,
      },
      started,
    );
  }

  private describe(args: JsonObject, started: number): QlooEnvelope {
    const r = resolve(String(args["entity"]), typeof args["type"] === "string" ? args["type"] : undefined);
    if (r.status !== "resolved") return this.needsInput("describe", "/entities", [issueFor(String(args["entity"]), "entity", r, "entity")], started, "Choose the intended Qloo entity.");
    return this.envelope("describe", "/entities", args, { status: "ok", summary: `Resolved ${r.entity.name}.`, interpretation: { entity: this.interpreted([{ input: String(args["entity"]), entity: r.entity }])[0] }, results: [compact(r.entity)], result_count: 1 }, started);
  }

  private wherePopular(args: JsonObject, started: number): QlooEnvelope {
    const path = "/v2/insights";
    const r = resolve(String(args["entity"]), "book");
    if (r.status !== "resolved") return this.needsInput("where_popular", path, [issueFor(String(args["entity"]), "entity", r, "entity")], started, "Choose the intended Qloo entity.");
    const place = placeOf(args["within"]);
    const interp = { entity: this.interpreted([{ input: String(args["entity"]), entity: r.entity }])[0], within: args["within"] };
    if (!place) return this.envelope("where_popular", path, args, { status: "empty", summary: "The sample dataset has heat data only for Newark, NJ and Austin, TX.", interpretation: interp, results: [], result_count: 0 }, started);
    const book = r.entity.book;
    const base = book ? Math.max(...Object.values(book.aff)) : 0.5;
    const offsets = [0.08, 0.04, 0, -0.03, -0.06, -0.1];
    const results = offsets.map((o, i) => ({
      location: { latitude: Number((place.lat + (i - 2) * 0.012).toFixed(4)), longitude: Number((place.lon + (i % 3) * 0.015).toFixed(4)) },
      query: { affinity: Number(Math.min(0.99, base + o).toFixed(2)) },
    }));
    return this.envelope("where_popular", path, args, { status: "ok", summary: `Found ${results.length} sample areas within ${place.name}.`, interpretation: interp, results, result_count: results.length }, started);
  }

  private trends(args: JsonObject, started: number): QlooEnvelope {
    const path = "/v2/trending";
    const ents = this.resolveMany(args["entities"], "entities", "book");
    if (ents.issues.length) return this.needsInput("trends", path, ents.issues, started);
    const end = new Date(`${String(args["end_date"])}T00:00:00Z`);
    const series = ents.ents.map(({ input, entity }) => {
      const trend = entity.book?.trend ?? "none";
      const points =
        trend === "none"
          ? []
          : Array.from({ length: 12 }, (_, i) => {
              const d = new Date(Date.UTC(end.getUTCFullYear(), end.getUTCMonth() - (11 - i), 1));
              const wiggle = ((i * 7) % 5) * 0.004;
              const v = trend === "rising" ? 0.3 + i * 0.022 : trend === "fading" ? 0.58 - i * 0.022 : 0.42 + wiggle;
              return { date: d.toISOString().slice(0, 10), popularity: Number(v.toFixed(3)) };
            });
      return { entity: this.interpreted([{ input, entity }])[0], points };
    });
    return this.envelope("trends", path, args, { status: "ok", summary: `Sample trend series for ${series.length} book(s).`, interpretation: { entity_type: "book", start_date: args["start_date"], end_date: args["end_date"] }, series, result_count: series.length }, started);
  }

  private compare(args: JsonObject, started: number): QlooEnvelope {
    const path = "/v2/analysis/compare";
    const a = this.resolveMany(args["group_a"], "group_a");
    const b = this.resolveMany(args["group_b"], "group_b");
    if (a.issues.length || b.issues.length) return this.needsInput("compare_audiences", path, [...a.issues, ...b.issues], started);
    const ka = a.ents.map((e) => e.entity.signalKey).filter((k): k is string => !!k);
    const kb = b.ents.map((e) => e.entity.signalKey).filter((k): k is string => !!k);
    const limit = typeof args["limit"] === "number" ? args["limit"] : 10;
    const rows = SAMPLE_BOOKS.flatMap((book) => {
      const sa = scoreBook(book, ka, { teens: false, placeBoost: 0 });
      const sb = scoreBook(book, kb, { teens: false, placeBoost: 0 });
      return sa !== undefined && sb !== undefined ? [{ book, s: Math.min(sa, sb) }] : [];
    })
      .sort((x, y) => y.s - x.s)
      .slice(0, limit);
    // PLACEHOLDER shape: the real /v2/analysis/compare payload is passed through raw by the harness and has not been recorded yet.
    return this.envelope("compare_audiences", path, args, {
      status: rows.length ? "ok" : "empty",
      summary: rows.length ? `Found ${rows.length} sample books both groups reach.` : "No sample book is shared by both groups.",
      interpretation: { group_a: this.interpreted(a.ents), group_b: this.interpreted(b.ents), target_type: args["target_type"] },
      results: { entities: rows.map((r) => compact({ id: `sample-book-${r.book.slug}`, name: r.book.name, type: "book", year: r.book.year }, r.s)) },
    }, started);
  }

  private entityTags(args: JsonObject, started: number): QlooEnvelope {
    const ents = this.resolveMany(args["entities"], "entities");
    if (ents.issues.length) return this.needsInput("entity_tags", "/v2/insights", ents.issues, started);
    const counts = new Map<string, number>();
    for (const { entity } of ents.ents) {
      const books = entity.book ? [entity.book] : SAMPLE_BOOKS.filter((bk) => entity.signalKey && bk.aff[entity.signalKey] !== undefined);
      for (const bk of books) for (const t of bk.tags) counts.set(t, (counts.get(t) ?? 0) + 1);
    }
    const max = Math.max(1, ...counts.values());
    const results = [...counts.entries()]
      .sort((x, y) => y[1] - x[1])
      .slice(0, typeof args["limit"] === "number" ? args["limit"] : 10)
      .map(([name, c]) => ({ id: `urn:tag:sample:${norm(name).replace(/ /g, "-")}`, name, type: "urn:tag:genre:sample", affinity: Number((c / max).toFixed(2)) }));
    return this.envelope("entity_tags", "/v2/insights", args, { status: results.length ? "ok" : "empty", summary: `${results.length} sample tags.`, interpretation: { entities: this.interpreted(ents.ents) }, results, result_count: results.length }, started);
  }

  private findTags(args: JsonObject, started: number): QlooEnvelope {
    const q = norm(String(args["query"]));
    const words = q.split(" ").filter(Boolean);
    const results = SAMPLE_TAGS.filter((t) => words.some((w) => norm(t).includes(w))).map((name) => ({ id: `urn:tag:sample:${norm(name).replace(/ /g, "-")}`, name, type: "urn:tag:genre:sample" }));
    return this.envelope("find_tags", "/v2/tags", args, { status: results.length ? "ok" : "empty", summary: results.length ? `${results.length} sample tags matched.` : "No sample tag matched.", interpretation: { query: args["query"] }, results, result_count: results.length }, started);
  }
}
