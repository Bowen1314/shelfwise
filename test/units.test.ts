import assert from "node:assert/strict";
import type { IncomingMessage } from "node:http";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, it } from "node:test";
import { extractJsonObject } from "../src/agent/guard.js";
import { type Session, SessionStore, newSession } from "../src/agent/session.js";
import { summarizeSeries } from "../src/agent/trend.js";
import { TtlCache, cacheKey } from "../src/qloo/cache.js";
import { TOOLS_SNAPSHOT, TOOLS_SNAPSHOT_HARNESS_VERSION } from "../src/qloo/fixtures/tools.snapshot.js";
import { McpQlooClient, resolveQlooCommand } from "../src/qloo/mcp-client.js";
import type { ToolDef } from "../src/qloo/types.js";
import { TREND_ENTITY_TYPES, isCalendarDate, schemaForLlm, stripHarmlessArgs, validateToolArgs } from "../src/qloo/validate.js";
import { EvidenceStore, entityTypeOf, normType } from "../src/agent/evidence.js";
import { DEFAULT_LLM_BASE_URL, DEFAULT_LLM_MODEL, loadConfig, readinessProblems } from "../src/server/config.js";
import { type AcquireResult, RunQueue } from "../src/server/queue.js";
import { RateLimiter, clientIp } from "../src/server/ratelimit.js";
import { parseForm, parseRunRequest } from "../src/server/request.js";
import { AGE_BANDS, type FormInput } from "../src/shared/types.js";

const tool = (name: string): ToolDef => {
  const t = TOOLS_SNAPSHOT.find((x) => x.name === name);
  if (!t) throw new Error(`no tool ${name} in TOOLS_SNAPSHOT`);
  return t;
};

// ------------------------------------------------------------------------------------------------
// summarizeSeries
// ------------------------------------------------------------------------------------------------

describe("summarizeSeries", () => {
  const pts = (values: number[], key = "popularity") => values.map((v, i) => ({ date: `2026-${String(i + 1).padStart(2, "0")}-01`, [key]: v }));

  it("reads the live /v2/trending point shape: population_percentile is the level, the velocity fields are ignored", () => {
    const live = (pcts: number[]) =>
      pcts.map((p, i) => ({
        date: `2026-${String(i + 3).padStart(2, "0")}-01`,
        population_percentile: p,
        population_rank: String(200 - i),
        population_rank_velocity: 5,
        velocity_fold_change: i % 2 ? 3 : -3,
        population_percent_delta: 0.5,
      }));
    const steady = summarizeSeries(live([0.93, 0.93, 0.93, 0.93, 0.93, 0.93]));
    assert.equal(steady.direction, "steady");
    assert.match(steady.basis, /population_percentile/);
    assert.equal(summarizeSeries(live([0.4, 0.42, 0.41, 0.6, 0.62, 0.61])).direction, "rising");
    assert.equal(summarizeSeries(live([0.8, 0.8, 0.79, 0.5, 0.5, 0.49])).direction, "fading");
    // Without the known key, the fallback still prefers a level whose name merely contains "lat" over a rate.
    const renamed = live([0.4, 0.4, 0.4, 0.7, 0.7, 0.7]).map(({ population_percentile, ...rest }) => ({ ...rest, population_share: population_percentile }));
    const r = summarizeSeries(renamed);
    assert.equal(r.direction, "rising");
    assert.match(r.basis, /population_share/);
  });

  it("reports rising when the second half mean is more than 10% above the first", () => {
    const r = summarizeSeries(pts([0.3, 0.3, 0.3, 0.5, 0.5, 0.5]));
    assert.equal(r.direction, "rising");
    assert.equal(r.points, 6);
    assert.match(r.basis, /first half/);
    assert.match(r.basis, /second half/);
    assert.match(r.basis, /popularity/);
  });

  it("reports fading when the second half mean is more than 10% below the first", () => {
    const r = summarizeSeries(pts([0.5, 0.5, 0.5, 0.3, 0.3, 0.3]));
    assert.equal(r.direction, "fading");
    assert.equal(r.points, 6);
  });

  it("reports steady for small wiggles", () => {
    const r = summarizeSeries(pts([0.4, 0.41, 0.4, 0.42, 0.41, 0.43]));
    assert.equal(r.direction, "steady");
  });

  it("uses a strict +/-10% threshold (integer arithmetic, so the boundary is exact)", () => {
    // first half mean 100; second half mean 110 is exactly +10%: not beyond the threshold.
    assert.equal(summarizeSeries(pts([100, 100, 100, 110, 110, 110])).direction, "steady");
    assert.equal(summarizeSeries(pts([100, 100, 100, 111, 111, 111])).direction, "rising");
    assert.equal(summarizeSeries(pts([100, 100, 100, 90, 90, 90])).direction, "steady");
    assert.equal(summarizeSeries(pts([100, 100, 100, 89, 89, 89])).direction, "fading");
  });

  it("compares the first floor(n/2) points with the last floor(n/2), ignoring the middle point of an odd series", () => {
    // 5 points: halves are [1,1] and [2,2]; the huge middle value must not matter.
    assert.equal(summarizeSeries(pts([1, 1, 1000, 2, 2])).direction, "rising");
    assert.equal(summarizeSeries(pts([2, 2, 1000, 1, 1])).direction, "fading");
  });

  it("sorts by date before splitting, whatever order the points arrive in", () => {
    const rising = pts([0.3, 0.3, 0.3, 0.5, 0.5, 0.5]);
    assert.equal(summarizeSeries([...rising].reverse()).direction, "rising");
  });

  it("treats growth from a zero baseline as rising and zero-to-zero as steady", () => {
    assert.equal(summarizeSeries(pts([0, 0, 0, 1, 1, 1])).direction, "rising");
    assert.equal(summarizeSeries(pts([0, 0, 0, 0, 0, 0])).direction, "steady");
  });

  it("reads metrics nested under query/metrics/stats and other numeric fields when no known metric exists", () => {
    const nested = [1, 2, 3, 4, 5, 6].map((i) => ({ date: `2026-0${i}-01`, query: { affinity: i < 4 ? 0.2 : 0.6 } }));
    assert.equal(summarizeSeries(nested).direction, "rising");
    const unknownKey = pts([10, 10, 10, 30, 30, 30], "volume");
    const r = summarizeSeries(unknownKey);
    assert.equal(r.direction, "rising");
    assert.match(r.basis, /volume/);
  });

  it("ignores undated or non-record points but still counts the dated ones", () => {
    const mixed: unknown[] = ["junk", null, 7, ...pts([1, 1, 1, 3, 3, 3])];
    const r = summarizeSeries(mixed);
    assert.equal(r.direction, "rising");
    assert.equal(r.points, 6);
  });

  it("returns unknown for an empty series", () => {
    const r = summarizeSeries([]);
    assert.equal(r.direction, "unknown");
    assert.equal(r.points, 0);
    assert.equal(typeof r.basis, "string");
    assert.ok(r.basis.length > 0);
  });

  it("returns unknown when points carry no dates", () => {
    const r = summarizeSeries([{ popularity: 1 }, { popularity: 2 }, { popularity: 3 }, { popularity: 9 }]);
    assert.equal(r.direction, "unknown");
    assert.equal(r.points, 4);
    assert.match(r.basis, /without dates/);
  });

  it("returns unknown when dates are not date-like strings", () => {
    const r = summarizeSeries([1, 2, 3, 4].map((i) => ({ date: `week ${i}`, popularity: i })));
    assert.equal(r.direction, "unknown");
  });

  it("returns unknown with fewer than 3 dated points", () => {
    assert.equal(summarizeSeries(pts([1, 5])).direction, "unknown");
    assert.equal(summarizeSeries(pts([1])).direction, "unknown");
    // two dated points plus undated ones still do not make a series
    const r = summarizeSeries([...pts([1, 5]), { popularity: 3 }, { popularity: 4 }]);
    assert.equal(r.direction, "unknown");
  });

  it("returns unknown when dated points have no numeric metric", () => {
    const r = summarizeSeries([1, 2, 3, 4].map((i) => ({ date: `2026-0${i}-01`, label: "x" })));
    assert.equal(r.direction, "unknown");
    assert.match(r.basis, /no numeric metric/);
  });
});

// ------------------------------------------------------------------------------------------------
// extractJsonObject
// ------------------------------------------------------------------------------------------------

describe("extractJsonObject", () => {
  it("parses plain JSON, with surrounding whitespace", () => {
    assert.deepEqual(extractJsonObject('{"a":1,"b":[1,2]}'), { a: 1, b: [1, 2] });
    assert.deepEqual(extractJsonObject('  \n {"a":1}\n '), { a: 1 });
  });

  it("parses JSON inside ```json fences and bare ``` fences", () => {
    assert.deepEqual(extractJsonObject('```json\n{"a":1}\n```'), { a: 1 });
    assert.deepEqual(extractJsonObject('```\n{"a":2}\n```'), { a: 2 });
    assert.deepEqual(extractJsonObject('Here is the report:\n```JSON\n{"a":3}\n```\nDone.'), { a: 3 });
  });

  it("finds a JSON object embedded in prose", () => {
    assert.deepEqual(extractJsonObject('Sure! Here you go: {"a":1} hope that helps'), { a: 1 });
  });

  it("handles nested braces", () => {
    assert.deepEqual(extractJsonObject('Result -> {"a":{"b":{"c":[{"d":1}]}}} (end)'), { a: { b: { c: [{ d: 1 }] } } });
  });

  it("is not fooled by braces and escaped quotes inside strings", () => {
    assert.deepEqual(extractJsonObject('x {"s":"a } b { c","n":1} y'), { s: "a } b { c", n: 1 });
    assert.deepEqual(extractJsonObject('x {"s":"he said \\"}\\" ok","n":2} y'), { s: 'he said "}" ok', n: 2 });
  });

  it("stops at the end of the first balanced object", () => {
    assert.deepEqual(extractJsonObject('{"a":1} and also {"b":2}'), { a: 1 });
  });

  it("returns undefined for garbage", () => {
    assert.equal(extractJsonObject("no json here at all"), undefined);
    assert.equal(extractJsonObject(""), undefined);
    assert.equal(extractJsonObject("   "), undefined);
    assert.equal(extractJsonObject("{unclosed"), undefined);
    assert.equal(extractJsonObject('{"a":1'), undefined);
    assert.equal(extractJsonObject("{not: json}"), undefined);
    assert.equal(extractJsonObject("} backwards {"), undefined);
  });

  it("keeps a JSON string that contains JSON as a string value (no double-decoding of fields)", () => {
    const inner = '{"x":1}';
    const out = extractJsonObject(JSON.stringify({ payload: inner, n: 2 }));
    assert.deepEqual(out, { payload: inner, n: 2 });
    // embedded in prose too
    assert.deepEqual(extractJsonObject(`Result: ${JSON.stringify({ payload: inner })}.`), { payload: inner });
  });

  it("returns a bare JSON string as that string, without unwrapping it into an object", () => {
    // Documented current behaviour: the plain JSON.parse succeeds and its (string) result is returned as is.
    assert.equal(extractJsonObject(JSON.stringify('{"x":1}')), '{"x":1}');
  });

  it("returns non-object JSON values as parsed (callers must check the type)", () => {
    assert.equal(extractJsonObject("42"), 42);
    assert.deepEqual(extractJsonObject("[1,2]"), [1, 2]);
    assert.equal(extractJsonObject("null"), null);
  });

  it("falls back to scanning when a fenced block is not valid JSON", () => {
    assert.deepEqual(extractJsonObject('```json\nnot json\n``` but here: {"ok":true}'), { ok: true });
  });

  it("finds the report when prose mentions an earlier {e12} placeholder", () => {
    assert.deepEqual(extractJsonObject('Here is the report for {e1}: {"bridge_shelf":[]}'), { bridge_shelf: [] });
  });

  it("skips any number of earlier brace groups that are not JSON, balanced or not", () => {
    assert.deepEqual(extractJsonObject('Compare {e1} with {e2}, then: {"a":1}'), { a: 1 });
    assert.deepEqual(extractJsonObject('a stray { brace, then {"a":2}'), { a: 2 });
    assert.deepEqual(extractJsonObject('{not json} {"a":3} {"b":4}'), { a: 3 });
    assert.equal(extractJsonObject("only {e1} and {e2} here"), undefined);
  });
});

// ------------------------------------------------------------------------------------------------
// cacheKey + TtlCache
// ------------------------------------------------------------------------------------------------

describe("cacheKey", () => {
  const rec = tool("qloo_recommend");
  const base = { target_type: "book", signals: ["Severance", "The Bear"], signal_location: "Newark, NJ" };

  it("prefixes the tool name and is stable for identical input", () => {
    const k = cacheKey(rec, "qloo_recommend", base);
    assert.ok(k.startsWith("qloo_recommend:"));
    assert.equal(cacheKey(rec, "qloo_recommend", { ...base }), k);
  });

  it("ignores case, surrounding and inner whitespace, and unicode compatibility forms", () => {
    const k = cacheKey(rec, "qloo_recommend", base);
    assert.equal(cacheKey(rec, "qloo_recommend", { target_type: "BOOK", signals: ["  severance ", "THE   BEAR"], signal_location: "newark,   nj" }), k);
    assert.equal(cacheKey(rec, "qloo_recommend", { ...base, signals: ["Ｓeverance", "The Bear"] }), k); // full-width S
  });

  it("ignores key order", () => {
    const reordered = { signal_location: "Newark, NJ", signals: ["Severance", "The Bear"], target_type: "book" };
    assert.equal(cacheKey(rec, "qloo_recommend", reordered), cacheKey(rec, "qloo_recommend", base));
  });

  it("treats set-like arrays as unordered (signals, include_tags, exclude_tags)", () => {
    const a = cacheKey(rec, "qloo_recommend", { ...base, signals: ["Severance", "The Bear"], include_tags: ["fantasy", "mystery"], exclude_tags: ["romance", "thriller"] });
    const b = cacheKey(rec, "qloo_recommend", { ...base, signals: ["The Bear", "Severance"], include_tags: ["Mystery", "Fantasy"], exclude_tags: ["thriller", "romance"] });
    assert.equal(a, b);
  });

  it("keeps the order of arrays that are not set-like", () => {
    const k1 = cacheKey(undefined, "x", { steps: ["a", "b"] });
    const k2 = cacheKey(undefined, "x", { steps: ["b", "a"] });
    assert.notEqual(k1, k2);
  });

  it("treats an explicitly passed schema default like an omitted argument", () => {
    const omitted = cacheKey(rec, "qloo_recommend", base);
    assert.equal(cacheKey(rec, "qloo_recommend", { ...base, limit: 10 }), omitted); // limit default 10
    assert.equal(cacheKey(rec, "qloo_recommend", { ...base, explain: true }), omitted); // explain default true
    assert.equal(cacheKey(rec, "qloo_recommend", { ...base, limit: 10, explain: true }), omitted);
  });

  it("does not drop a non-default value", () => {
    const omitted = cacheKey(rec, "qloo_recommend", base);
    assert.notEqual(cacheKey(rec, "qloo_recommend", { ...base, limit: 5 }), omitted);
    assert.notEqual(cacheKey(rec, "qloo_recommend", { ...base, explain: false }), omitted);
  });

  it("skips null and undefined arguments", () => {
    const omitted = cacheKey(rec, "qloo_recommend", base);
    assert.equal(cacheKey(rec, "qloo_recommend", { ...base, demographic: undefined, filter_location: null }), omitted);
  });

  it("does not mutate the arguments it was given", () => {
    const args = { target_type: "Book", signals: ["B", "a"] };
    const copy = structuredClone(args);
    cacheKey(rec, "qloo_recommend", args);
    assert.deepEqual(args, copy);
  });

  it("gives different keys for genuinely different inputs", () => {
    const k = cacheKey(rec, "qloo_recommend", base);
    assert.notEqual(cacheKey(rec, "qloo_recommend", { ...base, signal_location: "Austin, TX" }), k);
    assert.notEqual(cacheKey(rec, "qloo_recommend", { ...base, target_type: "movie" }), k);
    assert.notEqual(cacheKey(rec, "qloo_recommend", { ...base, signals: ["Severance"] }), k);
    assert.notEqual(cacheKey(rec, "qloo_recommend", { ...base, demographic: "teens" }), k);
    assert.notEqual(cacheKey(rec, "qloo_recommend", { ...base, include_tags: ["fantasy"] }), k);
    assert.notEqual(cacheKey(tool("qloo_rank"), "qloo_rank", base), k);
  });

  it("works when the tool definition is unknown", () => {
    assert.equal(cacheKey(undefined, "t", { a: " X " }), cacheKey(undefined, "t", { a: "x" }));
    assert.notEqual(cacheKey(undefined, "t", { a: "x" }), cacheKey(undefined, "u", { a: "x" }));
  });
});

describe("TtlCache", () => {
  it("returns a value until the TTL elapses, then drops it", () => {
    let t = 1_000;
    const c = new TtlCache<string>(500, 10, () => t);
    c.set("k", "v");
    assert.equal(c.get("k"), "v");
    t = 1_499;
    assert.equal(c.get("k"), "v");
    assert.equal(c.size, 1);
    t = 1_500; // expires <= now
    assert.equal(c.get("k"), undefined);
    assert.equal(c.size, 0);
    assert.equal(c.get("missing"), undefined);
  });

  it("does not extend the TTL on read, but set() restarts it", () => {
    let t = 0;
    const c = new TtlCache<number>(100, 10, () => t);
    c.set("k", 1);
    t = 90;
    assert.equal(c.get("k"), 1);
    t = 100;
    assert.equal(c.get("k"), undefined);
    c.set("k", 2);
    t = 150;
    c.set("k", 3);
    t = 240;
    assert.equal(c.get("k"), 3);
  });

  it("evicts the least recently used entry at max size", () => {
    const c = new TtlCache<number>(60_000, 2);
    c.set("a", 1);
    c.set("b", 2);
    assert.equal(c.get("a"), 1); // refresh a: b is now the oldest
    c.set("c", 3);
    assert.equal(c.size, 2);
    assert.equal(c.get("b"), undefined);
    assert.equal(c.get("a"), 1);
    assert.equal(c.get("c"), 3);
  });

  it("re-setting an existing key does not grow the cache and refreshes its recency", () => {
    const c = new TtlCache<number>(60_000, 2);
    c.set("a", 1);
    c.set("b", 2);
    c.set("a", 10);
    assert.equal(c.size, 2);
    c.set("c", 3); // evicts b, the oldest
    assert.equal(c.get("b"), undefined);
    assert.equal(c.get("a"), 10);
  });
});

// ------------------------------------------------------------------------------------------------
// validateToolArgs
// ------------------------------------------------------------------------------------------------

describe("validateToolArgs", () => {
  const rec = tool("qloo_recommend");
  const trends = tool("qloo_trends");
  const validRec = { target_type: "book", signals: ["Severance"], signal_location: "Newark, NJ", limit: 8 };
  const validTrends = { entities: ["Severance"], entity_type: "tv_show", start_date: "2025-10-01", end_date: "2026-10-01" };

  it("accepts a valid recommend call", () => {
    assert.deepEqual(validateToolArgs(rec, validRec), { ok: true, errors: [] });
    assert.deepEqual(validateToolArgs(rec, { target_type: "book" }), { ok: true, errors: [] });
  });

  it("rejects a missing required argument and names it", () => {
    const r = validateToolArgs(rec, { signals: ["Severance"] });
    assert.equal(r.ok, false);
    assert.ok(r.errors.some((e) => e.includes("missing required argument") && e.includes('"target_type"')), r.errors.join("|"));
  });

  it("rejects a value outside an enum and names the field", () => {
    const r = validateToolArgs(rec, { ...validRec, target_type: "podcastz" });
    assert.equal(r.ok, false);
    assert.ok(r.errors.some((e) => e.includes("target_type") && /allowed values/.test(e)), r.errors.join("|"));
    assert.equal(validateToolArgs(rec, { ...validRec, signal_tags_operator: "both" }).ok, false);
  });

  it("rejects unknown properties because the schema sets additionalProperties:false", () => {
    assert.equal(rec.inputSchema["additionalProperties"], false);
    const r = validateToolArgs(rec, { ...validRec, colour: "red" });
    assert.equal(r.ok, false);
    assert.ok(r.errors.some((e) => e.includes("unknown argument") && e.includes('"colour"')), r.errors.join("|"));
  });

  it("does not coerce types and reports the offending field", () => {
    const r = validateToolArgs(rec, { ...validRec, limit: "5" });
    assert.equal(r.ok, false);
    assert.ok(r.errors.some((e) => e.startsWith("limit ")), r.errors.join("|"));
    assert.equal(validateToolArgs(rec, { ...validRec, limit: 0 }).ok, false);
    assert.equal(validateToolArgs(rec, { ...validRec, limit: 21 }).ok, false);
    assert.equal(validateToolArgs(rec, { ...validRec, limit: 2.5 }).ok, false);
    assert.equal(validateToolArgs(rec, { ...validRec, limit: 20 }).ok, true);
  });

  it("checks array bounds and item constraints, with dotted paths for items", () => {
    assert.equal(validateToolArgs(rec, { ...validRec, signals: [] }).ok, false);
    assert.equal(validateToolArgs(rec, { ...validRec, signals: Array.from({ length: 11 }, (_, i) => `s${i}`) }).ok, false);
    const r = validateToolArgs(rec, { ...validRec, signals: ["ok", ""] });
    assert.equal(r.ok, false);
    assert.ok(r.errors.some((e) => e.startsWith("signals.1 ")), r.errors.join("|"));
  });

  it("reports every problem at once, as strings", () => {
    const r = validateToolArgs(rec, { target_type: "nope", limit: 0, extra: 1 });
    assert.equal(r.ok, false);
    assert.ok(r.errors.length >= 3, r.errors.join("|"));
    assert.ok(r.errors.every((e) => typeof e === "string" && e.length > 0));
    const joined = r.errors.join("|");
    for (const field of ["target_type", "limit", "extra"]) assert.ok(joined.includes(field), `${field} missing from: ${joined}`);
  });

  it("requires signal_location whenever demographic is given (recommend and rank)", () => {
    const noLoc = { target_type: "book", signals: ["Severance"], demographic: "teens" };
    const r = validateToolArgs(rec, noLoc);
    assert.equal(r.ok, false);
    assert.ok(r.errors.some((e) => e.includes('"demographic"') && e.includes('"signal_location"')), r.errors.join("|"));
    assert.equal(validateToolArgs(rec, { ...noLoc, signal_location: "Newark, NJ" }).ok, true);

    const rank = tool("qloo_rank");
    const rankArgs = { options: ["Piranesi"], option_type: "book" };
    assert.equal(validateToolArgs(rank, rankArgs).ok, true);
    assert.equal(validateToolArgs(rank, { ...rankArgs, demographic: "teens" }).ok, false);
    assert.equal(validateToolArgs(rank, { ...rankArgs, demographic: "teens", signal_location: "Newark, NJ" }).ok, true);
  });

  it("accepts valid trends arguments, including a one-day window and a leap day", () => {
    assert.deepEqual(validateToolArgs(trends, validTrends), { ok: true, errors: [] });
    assert.equal(validateToolArgs(trends, { ...validTrends, start_date: "2026-03-01", end_date: "2026-03-01" }).ok, true);
    assert.equal(validateToolArgs(trends, { ...validTrends, start_date: "2024-02-29", end_date: "2024-03-01" }).ok, true);
  });

  it("rejects trends with end_date before start_date", () => {
    const r = validateToolArgs(trends, { ...validTrends, start_date: "2026-10-02", end_date: "2026-10-01" });
    assert.equal(r.ok, false);
    assert.ok(r.errors.some((e) => e.includes("start_date") && e.includes("end_date")), r.errors.join("|"));
  });

  it("rejects trends dates that are not real calendar dates", () => {
    for (const bad of ["2026-02-30", "2025-02-29", "2026-13-01", "2026-04-31", "2026-00-10"]) {
      const r = validateToolArgs(trends, { ...validTrends, start_date: bad });
      assert.equal(r.ok, false, bad);
      assert.ok(r.errors.every((e) => typeof e === "string"));
      assert.ok(r.errors.some((e) => /calendar dates/.test(e) && e.includes("start_date")), `${bad}: ${r.errors.join("|")}`);
    }
    const r = validateToolArgs(trends, { ...validTrends, end_date: "2026-02-30" });
    assert.equal(r.ok, false);
    assert.ok(r.errors.some((e) => e.includes("end_date")));
  });

  it("rejects trends dates that do not match YYYY-MM-DD and names the field", () => {
    const r = validateToolArgs(trends, { ...validTrends, start_date: "2026-2-3" });
    assert.equal(r.ok, false);
    assert.ok(r.errors.some((e) => e.startsWith("start_date ")), r.errors.join("|"));
  });

  it("rejects trends on types Qloo's trending API cannot serve (books above all), naming the supported ones", () => {
    for (const bad of ["book", "place", "videogame"]) {
      const r = validateToolArgs(trends, { ...validTrends, entity_type: bad });
      assert.equal(r.ok, false, bad);
      assert.ok(r.errors.some((e) => e.includes(`"${bad}"`) && e.includes("no trend data") && e.includes("tv_show")), r.errors.join("|"));
    }
    for (const ok of TREND_ENTITY_TYPES) assert.equal(validateToolArgs(trends, { ...validTrends, entity_type: ok }).ok, true, ok);
    assert.deepEqual([...TREND_ENTITY_TYPES].sort(), ["artist", "brand", "movie", "person", "podcast", "tv_show"]);
    // The other tools keep accepting books.
    assert.equal(validateToolArgs(tool("qloo_where_popular"), { entity: "Piranesi", entity_type: "book", within: "Newark, NJ" }).ok, true);
  });

  it("stripHarmlessArgs drops limit only where the tool does not declare it, and nothing else", () => {
    const rank = tool("qloo_rank");
    const args = { options: ["Piranesi"], option_type: "book", limit: 5 };
    const out = stripHarmlessArgs(rank, args);
    assert.deepEqual(out.dropped, ["limit"]);
    assert.equal("limit" in out.args, false);
    assert.equal("limit" in args, true, "the input is not mutated");
    assert.equal(validateToolArgs(rank, out.args).ok, true);
    // Declared limits stay (and are still range-checked).
    const kept = stripHarmlessArgs(rec, { ...validRec, limit: 99 });
    assert.deepEqual(kept.dropped, []);
    assert.equal(validateToolArgs(rec, kept.args).ok, false);
    // Other unknown arguments are left for validation to reject.
    const other = stripHarmlessArgs(rank, { ...args, sort: "desc" });
    assert.deepEqual(other.dropped, ["limit"]);
    assert.equal(validateToolArgs(rank, other.args).ok, false);
  });

  it("applies the trends date rules only to qloo_trends", () => {
    const describe_ = tool("qloo_describe");
    assert.equal(validateToolArgs(describe_, { entity: "Dune" }).ok, true);
    assert.equal(validateToolArgs(describe_, {}).ok, false);
  });

  it("isCalendarDate understands month lengths and leap years", () => {
    for (const ok of ["2024-02-29", "2000-02-29", "2026-01-31", "2026-12-31", "2026-04-30"]) assert.equal(isCalendarDate(ok), true, ok);
    for (const bad of ["2023-02-29", "1900-02-29", "2026-04-31", "2026-00-10", "2026-01-00", "2026-13-01", "2026-1-1", "20260101", "", "2026-01-01T00:00:00Z"]) {
      assert.equal(isCalendarDate(bad), false, bad);
    }
  });

  it("schemaForLlm strips examples, $schema and uniqueItems recursively but keeps value constraints", () => {
    const out = schemaForLlm({ $schema: "x", type: "object", properties: { a: { type: "array", uniqueItems: true, items: { type: "string", examples: ["q"], minLength: 1 }, maxItems: 3 } } }) as {
      $schema?: unknown;
      properties: { a: Record<string, unknown> & { items: Record<string, unknown> } };
    };
    assert.equal(out.$schema, undefined);
    assert.equal(out.properties.a["uniqueItems"], undefined);
    assert.equal(out.properties.a.items["examples"], undefined);
    assert.equal(out.properties.a.items["minLength"], 1);
    assert.equal(out.properties.a["maxItems"], 3);
  });
});

// ------------------------------------------------------------------------------------------------
// loadConfig / readinessProblems
// ------------------------------------------------------------------------------------------------

// ------------------------------------------------------------------------------------------------
// Live result shapes in the evidence store
// ------------------------------------------------------------------------------------------------

describe("entity types from live rows", () => {
  it("normType strips the URN prefix and treats the bare urn:entity as no type", () => {
    assert.equal(normType("urn:entity:book"), "book");
    assert.equal(normType("urn:entity:tv_show"), "tv_show");
    assert.equal(normType("Book"), "book");
    assert.equal(normType("urn:entity"), undefined);
    assert.equal(normType(""), undefined);
    assert.equal(normType(undefined), undefined);
  });

  it("entityTypeOf prefers the specific subtype over a bare urn:entity type", () => {
    assert.equal(entityTypeOf({ type: "urn:entity", subtype: "urn:entity:book" }), "book");
    assert.equal(entityTypeOf({ type: "urn:entity:movie" }), "movie");
    assert.equal(entityTypeOf({ type: "urn:entity", types: ["urn:entity:podcast"] }), "podcast");
    assert.equal(entityTypeOf({ type: "urn:entity" }), undefined);
  });

  it("books from a live recommend result are typed book, and a bare type falls back to the call's target type", () => {
    const store = new EvidenceStore();
    const rec = store.addCall({
      callId: "c1",
      tool: "qloo_recommend",
      args: { target_type: "book", signals: ["Severance"] },
      envelope: {
        status: "ok",
        interpretation: { target_type: "urn:entity:book", signals: [{ input: "Severance", entityId: "s1", name: "Severance", type: "urn:entity:tv_show" }] },
        results: [
          { entity_id: "b1", name: "Piranesi", type: "urn:entity", subtype: "urn:entity:book" },
          { entity_id: "b2", name: "Dark Matter", type: "urn:entity" },
        ],
      },
      durationMs: 1,
      cached: false,
      sample: false,
    });
    assert.deepEqual(rec.view.preview.map((p) => p.type), ["book", "book"]);
    assert.equal(rec.resolved[0]?.entity.type, "tv_show");
    assert.equal(rec.view.summary, "recommend returned 2 items.");
  });
});

describe("where_popular summary", () => {
  const heat = (n: number) =>
    Array.from({ length: n }, (_, i) => ({ location: { geohash: `dr5r${i}` }, query: { affinity: Number((0.9 - i * 0.01).toFixed(2)) } }));
  const add = (store: EvidenceStore, results: unknown[], status: "ok" | "empty" = "ok") =>
    store.addCall({
      callId: store.nextCallId(),
      tool: "qloo_where_popular",
      args: { entity: "b1", entity_type: "book", within: "Newark, NJ" },
      // The live harness sends no `summary` here.
      envelope: { status, interpretation: { entity: { input: "b1", entityId: "b1", name: "Piranesi", type: "urn:entity:book" }, within: "Newark, NJ" }, results, result_count: results.length },
      durationMs: 1,
      cached: false,
      sample: false,
    });

  it("reports the heatmap areas instead of '0 items'", () => {
    const rec = add(new EvidenceStore(), heat(10));
    assert.equal(rec.view.resultCount, 10);
    assert.equal(rec.view.summary, "Qloo returned 10 areas within Newark, NJ; the strongest has affinity 0.9.");
    assert.equal(rec.local?.areas, 10);
  });

  it("keeps a summary the harness did send, and says so when nothing came back", () => {
    const store = new EvidenceStore();
    const withSummary = store.addCall({
      callId: store.nextCallId(),
      tool: "qloo_where_popular",
      args: { entity: "b1", within: "Newark, NJ" },
      envelope: { status: "ok", summary: "Harness summary.", interpretation: { entity: { input: "b1", entityId: "b1", name: "Piranesi" }, within: "Newark, NJ" }, results: heat(2) },
      durationMs: 1,
      cached: false,
      sample: false,
    });
    assert.equal(withSummary.view.summary, "Harness summary.");
    assert.equal(add(store, [], "empty").view.summary, "Qloo returned no matches.");
  });

  it("falls back to the reported result_count for tools Shelfwise does not parse", () => {
    const store = new EvidenceStore();
    const rec = store.addCall({
      callId: store.nextCallId(),
      tool: "qloo_audience_demographics",
      args: { entity: "Severance" },
      envelope: { status: "ok", results: [{ age: "25_to_29" }, { age: "30_to_34" }, { age: "35_and_younger" }], result_count: 3 },
      durationMs: 1,
      cached: false,
      sample: false,
    });
    assert.equal(rec.view.summary, "audience_demographics returned 3 items.");
  });
});

describe("loadConfig", () => {
  it("has the documented defaults and no problems for an empty environment", () => {
    const c = loadConfig({});
    assert.equal(c.port, 8790);
    assert.equal(c.host, "127.0.0.1");
    assert.equal(c.trustProxy, 0);
    assert.equal(c.demoFixtures, false);
    assert.equal(c.qlooApiKey, undefined);
    assert.equal(c.llm.apiKey, undefined);
    assert.equal(c.llm.baseUrl, "https://api.tokenfactory.nebius.com/v1/");
    assert.equal(c.llm.baseUrl, DEFAULT_LLM_BASE_URL);
    assert.equal(c.llm.model, "nvidia/nemotron-3-super-120b-a12b");
    assert.equal(c.llm.model, DEFAULT_LLM_MODEL);
    assert.equal(c.llm.extraBody, undefined);
    assert.equal(c.limits.runsPerHour, 6);
    assert.equal(c.limits.messagesPerHour, 40);
    assert.equal(c.limits.maxConcurrentRuns, 2);
    assert.equal(c.limits.maxQueue, 8);
    assert.equal(c.limits.maxSessionFollowUps, 12);
    assert.equal(c.limits.dailyCallBudget, 1500);
    assert.equal(c.agent.qlooConcurrency, 3);
    assert.equal(c.cache.ttlMs, 720 * 60_000);
    assert.equal(c.cache.maxEntries, 500);
    assert.deepEqual(c.parseProblems, []);
  });

  it("does not read process.env when given an explicit env", () => {
    const before = process.env["PORT"];
    process.env["PORT"] = "1234";
    try {
      assert.equal(loadConfig({}).port, 8790);
    } finally {
      if (before === undefined) delete process.env["PORT"];
      else process.env["PORT"] = before;
    }
  });

  it("accepts valid overrides and trims strings", () => {
    const c = loadConfig({ PORT: "3000", HOST: " 0.0.0.0 ", SHELFWISE_LLM_BASE_URL: " http://localhost:9/v1 ", SHELFWISE_LLM_MODEL: "m", QLOO_API_KEY: " qk ", MAX_QUEUE: "0", CACHE_TTL_MINUTES: "5" });
    assert.equal(c.port, 3000);
    assert.equal(c.host, "0.0.0.0");
    assert.equal(c.llm.baseUrl, "http://localhost:9/v1");
    assert.equal(c.llm.model, "m");
    assert.equal(c.qlooApiKey, "qk");
    assert.equal(c.limits.maxQueue, 0); // 0 is inside the allowed range for MAX_QUEUE
    assert.equal(c.cache.ttlMs, 300_000);
    assert.deepEqual(c.parseProblems, []);
  });

  it("treats blank strings as unset", () => {
    const c = loadConfig({ HOST: "  ", PORT: "", SHELFWISE_LLM_BASE_URL: "", SHELFWISE_LLM_MODEL: " ", QLOO_API_KEY: " ", NEBIUS_API_KEY: "" });
    assert.equal(c.host, "127.0.0.1");
    assert.equal(c.port, 8790);
    assert.equal(c.llm.baseUrl, DEFAULT_LLM_BASE_URL);
    assert.equal(c.llm.model, DEFAULT_LLM_MODEL);
    assert.equal(c.qlooApiKey, undefined);
    assert.equal(c.llm.apiKey, undefined);
    assert.deepEqual(c.parseProblems, []);
  });

  it("takes the model key from NEBIUS_API_KEY and nowhere else", () => {
    assert.equal(loadConfig({ NEBIUS_API_KEY: "nebius" }).llm.apiKey, "nebius");
    assert.equal(loadConfig({ NEBIUS_API_KEY: "  nebius  " }).llm.apiKey, "nebius");
    assert.equal(loadConfig({ NEBIUS_API_KEY: "   " }).llm.apiKey, undefined);
  });

  it("ignores generic variables that belong to other tools: no key, default base URL, default model", () => {
    // The incident: another tool's LLM_API_KEY sat in the shell and was sent to Nebius as a Bearer token.
    const foreign = {
      LLM_API_KEY: "another-tools-key",
      OPENAI_API_KEY: "another-tools-openai-key",
      LLM_BASE_URL: "https://other.example.test/v1",
      LLM_MODEL: "another-tools-model",
      LLM_TIMEOUT_MS: "12345",
      LLM_MAX_TOKENS: "999",
      LLM_EXTRA_BODY: '{"x":1}',
    };
    const c = loadConfig(foreign);
    assert.equal(c.llm.apiKey, undefined);
    assert.equal(c.llm.baseUrl, DEFAULT_LLM_BASE_URL);
    assert.equal(c.llm.model, DEFAULT_LLM_MODEL);
    assert.equal(c.llm.timeoutMs, 90_000);
    assert.equal(c.llm.maxTokens, 4096);
    assert.equal(c.llm.extraBody, undefined);
    assert.deepEqual(c.parseProblems, []);
    // They do not count as the key in live mode either, and they do not disturb a real NEBIUS_API_KEY.
    assert.ok(readinessProblems(loadConfig({ QLOO_API_KEY: "q", ...foreign })).some((p) => p.includes("NEBIUS_API_KEY")));
    assert.equal(loadConfig({ NEBIUS_API_KEY: "ours", ...foreign }).llm.apiKey, "ours");
  });

  it("with generic LLM variables in the real process environment, the default config has no key and the default URL and model", () => {
    const names = ["LLM_API_KEY", "OPENAI_API_KEY", "LLM_BASE_URL", "LLM_MODEL"];
    // Shelfwise's own variables are cleared for the test so a developer's real .env/shell cannot change the outcome.
    const own = ["NEBIUS_API_KEY", "SHELFWISE_LLM_BASE_URL", "SHELFWISE_LLM_MODEL"];
    const saved = [...names, ...own].map((n) => [n, process.env[n]] as const);
    try {
      for (const n of own) delete process.env[n];
      for (const n of names) process.env[n] = `value-of-${n.toLowerCase()}`;
      const c = loadConfig(); // no argument: reads process.env, exactly as the server does
      assert.equal(c.llm.apiKey, undefined);
      assert.equal(c.llm.baseUrl, DEFAULT_LLM_BASE_URL);
      assert.equal(c.llm.model, DEFAULT_LLM_MODEL);
    } finally {
      for (const [n, v] of saved) {
        if (v === undefined) delete process.env[n];
        else process.env[n] = v;
      }
    }
  });

  it("reads the model settings only under the SHELFWISE_ prefix", () => {
    const c = loadConfig({ SHELFWISE_LLM_BASE_URL: "http://localhost:9/v1", SHELFWISE_LLM_MODEL: "m", SHELFWISE_LLM_TIMEOUT_MS: "20000", SHELFWISE_LLM_MAX_TOKENS: "2048" });
    assert.equal(c.llm.baseUrl, "http://localhost:9/v1");
    assert.equal(c.llm.model, "m");
    assert.equal(c.llm.timeoutMs, 20_000);
    assert.equal(c.llm.maxTokens, 2048);
  });

  it("parses DEMO_FIXTURES truthy values case-insensitively and nothing else", () => {
    for (const v of ["1", "true", "TRUE", "yes", "on", " On "]) assert.equal(loadConfig({ DEMO_FIXTURES: v }).demoFixtures, true, v);
    for (const v of ["0", "false", "", "no", "off", "2", "enabled", undefined]) assert.equal(loadConfig({ DEMO_FIXTURES: v }).demoFixtures, false, String(v));
  });

  it("parses TRUST_PROXY as a hop count", () => {
    const tp = (v: string | undefined) => loadConfig({ TRUST_PROXY: v }).trustProxy;
    assert.equal(tp(undefined), 0);
    assert.equal(tp(""), 0);
    assert.equal(tp("0"), 0);
    assert.equal(tp("1"), 1);
    assert.equal(tp("true"), 1);
    assert.equal(tp("TRUE"), 1);
    assert.equal(tp("yes"), 1);
    assert.equal(tp("on"), 1);
    assert.equal(tp("2"), 2);
    assert.equal(tp("3"), 3);
    assert.equal(tp("99"), 10); // capped
    assert.equal(tp("false"), 0);
    assert.equal(tp("banana"), 0); // fails safe: forwarding headers stay untrusted
    assert.equal(tp("-1"), 0);
  });

  it("falls back to the default AND records a problem for out-of-range or non-integer numbers", () => {
    const cases: [string, string, (c: ReturnType<typeof loadConfig>) => number, number][] = [
      ["PORT", "70000", (c) => c.port, 8790],
      ["PORT", "0", (c) => c.port, 8790],
      ["PORT", "abc", (c) => c.port, 8790],
      ["PORT", "80.5", (c) => c.port, 8790],
      ["RATE_LIMIT_RUNS_PER_HOUR", "0", (c) => c.limits.runsPerHour, 6],
      ["MAX_QUEUE", "-1", (c) => c.limits.maxQueue, 8],
      ["MAX_QUEUE", "201", (c) => c.limits.maxQueue, 8],
      ["MAX_CONCURRENT_RUNS", "0", (c) => c.limits.maxConcurrentRuns, 2],
      ["SHELFWISE_LLM_TIMEOUT_MS", "10", (c) => c.llm.timeoutMs, 90_000],
      ["QLOO_CONCURRENCY", "11", (c) => c.agent.qlooConcurrency, 3],
    ];
    for (const [key, raw, read, dflt] of cases) {
      const c = loadConfig({ [key]: raw });
      assert.equal(read(c), dflt, `${key}=${raw}`);
      assert.equal(c.parseProblems.length, 1, `${key}=${raw}: ${c.parseProblems.join("|")}`);
      assert.ok(c.parseProblems[0]?.includes(key), c.parseProblems[0]);
      assert.ok(c.parseProblems[0]?.includes(`"${raw}"`), c.parseProblems[0]);
    }
  });

  it("collects one problem per bad variable", () => {
    const c = loadConfig({ PORT: "x", MAX_QUEUE: "y", SHELFWISE_LLM_MAX_TOKENS: "1" });
    assert.equal(c.parseProblems.length, 3);
  });

  it("parses SHELFWISE_LLM_EXTRA_BODY when it is a JSON object", () => {
    const c = loadConfig({ SHELFWISE_LLM_EXTRA_BODY: '{"chat_template_kwargs":{"enable_thinking":false}}' });
    assert.deepEqual(c.llm.extraBody, { chat_template_kwargs: { enable_thinking: false } });
    assert.deepEqual(c.parseProblems, []);
  });

  it("ignores an invalid SHELFWISE_LLM_EXTRA_BODY and records a problem", () => {
    for (const bad of ["{nope", "[1,2]", '"str"', "42", "null"]) {
      const c = loadConfig({ SHELFWISE_LLM_EXTRA_BODY: bad });
      assert.equal(c.llm.extraBody, undefined, bad);
      assert.equal(c.parseProblems.length, 1, bad);
      assert.ok(c.parseProblems[0]?.includes("SHELFWISE_LLM_EXTRA_BODY"), bad);
    }
  });
});

describe("readinessProblems", () => {
  it("live mode without keys names both missing keys", () => {
    const problems = readinessProblems(loadConfig({}));
    assert.equal(problems.length, 2);
    assert.ok(problems.some((p) => p.includes("QLOO_API_KEY")));
    assert.ok(problems.some((p) => p.includes("NEBIUS_API_KEY")));
  });

  it("live mode reports only the key that is missing", () => {
    const onlyQloo = readinessProblems(loadConfig({ QLOO_API_KEY: "q" }));
    assert.equal(onlyQloo.length, 1);
    assert.ok(onlyQloo[0]?.includes("NEBIUS_API_KEY"));
    const onlyLlm = readinessProblems(loadConfig({ NEBIUS_API_KEY: "l" }));
    assert.equal(onlyLlm.length, 1);
    assert.ok(onlyLlm[0]?.includes("QLOO_API_KEY"));
  });

  it("live mode is ready with both keys", () => {
    assert.deepEqual(readinessProblems(loadConfig({ QLOO_API_KEY: "q", NEBIUS_API_KEY: "n" })), []);
  });

  it("fixtures mode needs no keys", () => {
    assert.deepEqual(readinessProblems(loadConfig({ DEMO_FIXTURES: "1" })), []);
    assert.deepEqual(readinessProblems(loadConfig({ DEMO_FIXTURES: "true", QLOO_API_KEY: "q" })), []);
  });

  it("malformed optional settings are warnings, not blockers: they never make a run refuse to start", () => {
    const demo = loadConfig({ DEMO_FIXTURES: "1", MAX_QUEUE: "-5" });
    assert.equal(demo.parseProblems.length, 1);
    assert.ok(demo.parseProblems[0]?.includes("MAX_QUEUE"));
    assert.deepEqual(readinessProblems(demo), []);
    const live = loadConfig({ QLOO_API_KEY: "q", NEBIUS_API_KEY: "l", PORT: "x" });
    assert.ok(live.parseProblems[0]?.includes("PORT"));
    assert.deepEqual(readinessProblems(live), []);
    // Only the missing keys block a live run.
    assert.equal(readinessProblems(loadConfig({ PORT: "x" })).length, 2);
  });

  it("returns a fresh array each time (callers may mutate it)", () => {
    const cfg = loadConfig({ DEMO_FIXTURES: "1" });
    readinessProblems(cfg).push("x");
    assert.deepEqual(readinessProblems(cfg), []);
  });
});

// ------------------------------------------------------------------------------------------------
// parseForm / parseRunRequest
// ------------------------------------------------------------------------------------------------

describe("parseForm", () => {
  const form = { place: "Newark, NJ", ageBand: "teens", interests: "Severance, The Bear", titleCount: 8, budget: 400, avgPrice: 18 };

  const failure = (raw: unknown): string => {
    const r = parseForm(raw);
    assert.equal(r.ok, false, JSON.stringify(raw));
    return r.ok ? "" : r.message;
  };

  it("accepts a valid form and returns the normalised value", () => {
    const r = parseForm(form);
    assert.ok(r.ok);
    if (r.ok) assert.deepEqual(r.value, { place: "Newark, NJ", ageBand: "teens", interests: "Severance, The Bear", titleCount: 8, budget: 400, avgPrice: 18 });
  });

  it("applies defaults: ageBand any, titleCount 8, optional numbers omitted", () => {
    const r = parseForm({ place: "Austin, TX", interests: "Hades" });
    assert.ok(r.ok);
    if (r.ok) {
      assert.deepEqual(r.value, { place: "Austin, TX", ageBand: "any", interests: "Hades", titleCount: 8 });
      assert.equal("budget" in r.value, false);
      assert.equal("avgPrice" in r.value, false);
    }
    for (const empty of [undefined, null, ""]) {
      const e = parseForm({ ...form, budget: empty, avgPrice: empty });
      assert.ok(e.ok);
      if (e.ok) assert.equal("budget" in e.value, false);
    }
  });

  it("trims text and normalises CRLF to LF", () => {
    const r = parseForm({ ...form, place: "  Newark, NJ  ", interests: "  Severance,\r\nThe Bear \n" });
    assert.ok(r.ok);
    if (r.ok) {
      assert.equal(r.value.place, "Newark, NJ");
      assert.equal(r.value.interests, "Severance,\nThe Bear");
    }
  });

  it("accepts every listed audience band and rejects an unknown one", () => {
    for (const band of AGE_BANDS) {
      const r = parseForm({ ...form, ageBand: band.id });
      assert.ok(r.ok, band.id);
    }
    assert.match(failure({ ...form, ageBand: "elderly" }), /Audience is not one of the listed options/);
    assert.match(failure({ ...form, ageBand: "TEENS" }), /Audience/);
  });

  it("rejects email addresses in place and interests", () => {
    assert.match(failure({ ...form, interests: "I like Dune, mail me at pat@example.com" }), /email addresses and phone numbers/);
    assert.match(failure({ ...form, place: "pat@example.com" }), /email addresses and phone numbers/);
  });

  it("rejects phone numbers in many common shapes", () => {
    for (const phone of ["973-555-0100", "+1 973 555 0100", "9735550100", "973.555.0100", "(973)555-0100", "+1-973-555-0100", "1-800-555-0199", "+44 20 7946 0958"]) {
      assert.match(failure({ ...form, interests: `Severance, call ${phone}` }), /email addresses and phone numbers/, phone);
      assert.match(failure({ ...form, place: `Newark ${phone}` }), /email addresses and phone numbers/, phone);
    }
  });

  it(
    "rejects US-style phone numbers written with a parenthesised area code followed by a space",
    () => {
      for (const phone of ["(973) 555-0100", "+1 (973) 555-0100", "973 - 555 - 0100", "+1 (973) 555 0100", "(973) 555 - 0100"]) {
        assert.match(failure({ ...form, interests: `Severance, call ${phone}` }), /email addresses and phone numbers/, phone);
        assert.match(failure({ ...form, place: `Newark ${phone}` }), /email addresses and phone numbers/, phone);
      }
    },
  );

  it("does not mistake ordinary numbers in titles for phone numbers", () => {
    for (const interests of ["Fahrenheit 451, Apollo 13, Catch-22", "Blade Runner 2049 and Se7en", "The 2020 election podcast"]) {
      assert.ok(parseForm({ ...form, interests }).ok, interests);
    }
    assert.ok(parseForm({ ...form, place: "Newark, NJ 07102" }).ok);
  });

  it("accepts zip+4 codes and runs of years, which only look like long digit strings", () => {
    assert.ok(parseForm({ ...form, place: "Newark, NJ 07102-1234" }).ok);
    for (const interests of ["Books from 1984 2001 and 1914-1918", "Fahrenheit 451 1984, Dune 1965", "ISBN-free list: 1984, 2001, 2010, 1999"]) {
      assert.ok(parseForm({ ...form, interests }).ok, interests);
    }
  });

  it("rejects a non-string ageBand instead of silently treating it as 'any'", () => {
    for (const bad of [5, null, true, ["teens"], { id: "teens" }]) {
      assert.match(failure({ ...form, ageBand: bad as never }), /Audience is not one of the listed options/, String(bad));
    }
    const omitted = { ...form } as Record<string, unknown>;
    delete omitted["ageBand"];
    const r = parseForm(omitted);
    assert.ok(r.ok && r.value.ageBand === "any", "an omitted ageBand still means 'any'");
  });

  it("enforces length limits (place 2-80, interests 3-600)", () => {
    assert.match(failure({ ...form, place: "N" }), /Place is too short/);
    assert.match(failure({ ...form, place: "   " }), /Place is too short/);
    assert.ok(parseForm({ ...form, place: "N".repeat(80) }).ok);
    assert.match(failure({ ...form, place: "N".repeat(81) }), /Place is too long \(max 80/);
    assert.match(failure({ ...form, interests: "ab" }), /too short/);
    assert.ok(parseForm({ ...form, interests: "x".repeat(600) }).ok);
    assert.match(failure({ ...form, interests: "x".repeat(601) }), /too long \(max 600/);
  });

  it("requires place and interests to be strings", () => {
    assert.match(failure({ ...form, place: 5 }), /Place is required/);
    assert.match(failure({ ...form, place: undefined }), /Place is required/);
    assert.match(failure({ ...form, interests: ["Severance"] }), /is required/);
    assert.match(failure({ place: "Newark, NJ" }), /is required/);
  });

  it("enforces titleCount as an integer from 3 to 20", () => {
    for (const ok of [3, 4, 19, 20]) assert.ok(parseForm({ ...form, titleCount: ok }).ok, String(ok));
    for (const bad of [2, 0, -1, 21, 100, 5.5, "8", true, []]) assert.match(failure({ ...form, titleCount: bad }), /Number of titles must be a whole number from 3 to 20/, String(bad));
  });

  it("validates optional budget and average price as positive finite numbers", () => {
    for (const bad of [0, -5, "100", 10_000_001, true, {}]) {
      assert.match(failure({ ...form, budget: bad }), /Budget must be a positive number/, String(bad));
      assert.match(failure({ ...form, avgPrice: bad }), /Average price must be a positive number/, String(bad));
    }
    assert.ok(parseForm({ ...form, budget: 10_000_000 }).ok);
    assert.ok(parseForm({ ...form, budget: 0.5 }).ok);
  });

  it("rejects control characters but allows tabs and newlines", () => {
    for (const c of ["\u0000", "\u0007", "\u001b", "\u007f", "\u000b", "\u000c"]) {
      assert.match(failure({ ...form, interests: `Seve${c}rance` }), /characters that are not allowed/, JSON.stringify(c));
      assert.match(failure({ ...form, place: `New${c}ark` }), /characters that are not allowed/, JSON.stringify(c));
    }
    assert.ok(parseForm({ ...form, interests: "Severance,\tThe Bear\nHades" }).ok);
  });

  it("rejects a missing or non-object form", () => {
    for (const raw of [null, undefined, "form", 7, false]) assert.match(failure(raw), /The form is missing/);
  });
});

describe("parseRunRequest", () => {
  const form = { place: "Newark, NJ", ageBand: "any", interests: "Severance, The Bear", titleCount: 5 };
  const SID = "0123456789abcdef0123456789abcdef";

  const failure = (raw: unknown): string => {
    const r = parseRunRequest(raw);
    assert.equal(r.ok, false, JSON.stringify(raw));
    return r.ok ? "" : r.message;
  };

  it("accepts a form request", () => {
    const r = parseRunRequest({ input: { kind: "form", form } });
    assert.ok(r.ok);
    if (r.ok) {
      assert.equal(r.value.sessionId, undefined);
      assert.equal(r.value.input.kind, "form");
      if (r.value.input.kind === "form") assert.deepEqual(r.value.input.form, form);
    }
  });

  it("propagates form validation messages", () => {
    assert.match(failure({ input: { kind: "form", form: { ...form, interests: "call 973-555-0100" } } }), /email addresses and phone numbers/);
    assert.match(failure({ input: { kind: "form", form: { ...form, titleCount: 99 } } }), /Number of titles/);
    assert.match(failure({ input: { kind: "form" } }), /The form is missing/);
  });

  it("rejects a body that is not an object, and a missing or unknown input", () => {
    for (const body of [null, undefined, "x", 42, true]) assert.match(failure(body), /request body must be a JSON object/);
    assert.match(failure({}), /Missing input/);
    assert.match(failure({ input: "form" }), /Missing input/);
    assert.match(failure({ input: null }), /Missing input/);
    assert.match(failure({ input: {} }), /Unknown input kind/);
    assert.match(failure({ input: { kind: "delete" } }), /Unknown input kind/);
    assert.match(failure([]), /Missing input/);
  });

  it("ignores a valid session id on a form request but rejects a malformed one", () => {
    const ok = parseRunRequest({ sessionId: SID, input: { kind: "form", form } });
    assert.ok(ok.ok);
    if (ok.ok) assert.equal(ok.value.sessionId, undefined);
    assert.match(failure({ sessionId: "nope", input: { kind: "form", form } }), /Unknown session/);
  });

  it("requires a session id of 32 lowercase hex characters for message and resolution", () => {
    const message = { kind: "message", text: "make it for teens" };
    const resolution = { kind: "resolution", choices: [{ issueId: "c1.1", pick: null }] };
    assert.match(failure({ input: message }), /follow-up needs a session/);
    assert.match(failure({ input: resolution }), /answer needs a session/);
    for (const bad of [SID.toUpperCase(), SID.slice(1), `${SID}0`, "g".repeat(32), "", 12345, null, {}, `${SID.slice(0, 31)} `]) {
      assert.match(failure({ sessionId: bad, input: message }), /Unknown session/, JSON.stringify(bad));
      assert.match(failure({ sessionId: bad, input: resolution }), /Unknown session/, JSON.stringify(bad));
    }
    assert.ok(parseRunRequest({ sessionId: SID, input: message }).ok);
    assert.ok(parseRunRequest({ sessionId: SID, input: resolution }).ok);
  });

  it("validates follow-up messages", () => {
    const r = parseRunRequest({ sessionId: SID, input: { kind: "message", text: "  make it for teens \r\n" } });
    assert.ok(r.ok);
    if (r.ok) assert.deepEqual(r.value, { sessionId: SID, input: { kind: "message", text: "make it for teens" } });
    assert.match(failure({ sessionId: SID, input: { kind: "message", text: "" } }), /Message is too short/);
    assert.match(failure({ sessionId: SID, input: { kind: "message", text: "   " } }), /Message is too short/);
    assert.match(failure({ sessionId: SID, input: { kind: "message" } }), /Message is required/);
    assert.match(failure({ sessionId: SID, input: { kind: "message", text: 5 } }), /Message is required/);
    assert.ok(parseRunRequest({ sessionId: SID, input: { kind: "message", text: "x".repeat(500) } }).ok);
    assert.match(failure({ sessionId: SID, input: { kind: "message", text: "x".repeat(501) } }), /Message is too long \(max 500/);
    assert.match(failure({ sessionId: SID, input: { kind: "message", text: "ring me on 973 555 0100" } }), /email addresses and phone numbers/);
    assert.match(failure({ sessionId: SID, input: { kind: "message", text: "bad\u0000text" } }), /characters that are not allowed/);
  });

  it("accepts resolution choices, including a skip (pick: null), and trusts only the id", () => {
    const r = parseRunRequest({
      sessionId: SID,
      input: {
        kind: "resolution",
        choices: [
          { issueId: "c1.1", pick: { id: "sample-sig-dune-book", name: "Dune", type: "book", description: "extra", releaseYear: 1965 } },
          { issueId: "c1.2", pick: null },
          { issueId: "c1.3", pick: { id: "only-an-id" } },
        ],
      },
    });
    assert.ok(r.ok);
    if (r.ok) {
      assert.deepEqual(r.value, {
        sessionId: SID,
        input: {
          kind: "resolution",
          choices: [
            { issueId: "c1.1", pick: { id: "sample-sig-dune-book", name: "Dune" } },
            { issueId: "c1.2", pick: null },
            { issueId: "c1.3", pick: { id: "only-an-id", name: "" } },
          ],
        },
      });
    }
  });

  it("rejects missing, empty or oversized choice lists", () => {
    for (const choices of [undefined, null, [], "c1.1", {}]) assert.match(failure({ sessionId: SID, input: { kind: "resolution", choices } }), /Choices are missing/, JSON.stringify(choices));
    const many = Array.from({ length: 21 }, (_, i) => ({ issueId: `c1.${i}`, pick: null }));
    assert.match(failure({ sessionId: SID, input: { kind: "resolution", choices: many } }), /Choices are missing/);
    assert.ok(parseRunRequest({ sessionId: SID, input: { kind: "resolution", choices: many.slice(0, 20) } }).ok);
  });

  it("rejects malformed choices", () => {
    const bad: unknown[] = [
      null,
      "c1.1",
      {},
      { issueId: 5, pick: null },
      { issueId: "x".repeat(41), pick: null },
      { issueId: "c1.1" }, // pick missing
      { issueId: "c1.1", pick: "dune" },
      { issueId: "c1.1", pick: {} },
      { issueId: "c1.1", pick: { id: 7 } },
      { issueId: "c1.1", pick: [] },
    ];
    for (const choice of bad) assert.match(failure({ sessionId: SID, input: { kind: "resolution", choices: [choice] } }), /A choice is malformed/, JSON.stringify(choice));
    // one bad choice among good ones still fails the whole request
    assert.match(failure({ sessionId: SID, input: { kind: "resolution", choices: [{ issueId: "c1.1", pick: null }, { issueId: 3, pick: null }] } }), /malformed/);
    assert.ok(parseRunRequest({ sessionId: SID, input: { kind: "resolution", choices: [{ issueId: "x".repeat(40), pick: null }] } }).ok);
  });
});

// ------------------------------------------------------------------------------------------------
// RateLimiter + clientIp
// ------------------------------------------------------------------------------------------------

describe("RateLimiter", () => {
  it("allows N hits then rejects with a sensible retryAfterSec", () => {
    let t = 0;
    const rl = new RateLimiter(3, 60_000, () => t);
    for (const at of [0, 10_000, 20_000]) {
      t = at;
      assert.deepEqual(rl.take("a"), { ok: true });
    }
    t = 30_000;
    const r = rl.take("a");
    assert.equal(r.ok, false);
    if (!r.ok) {
      assert.equal(r.retryAfterSec, 30); // oldest hit (t=0) leaves the window at t=60_000
      assert.ok(Number.isInteger(r.retryAfterSec) && r.retryAfterSec >= 1);
    }
  });

  it("never reports less than one second, even a millisecond before the window opens", () => {
    let t = 0;
    const rl = new RateLimiter(1, 60_000, () => t);
    assert.equal(rl.take("a").ok, true);
    t = 59_999;
    const r = rl.take("a");
    assert.equal(r.ok, false);
    if (!r.ok) assert.equal(r.retryAfterSec, 1);
  });

  it("recovers exactly when the oldest hit leaves the window; rejected attempts do not count as hits", () => {
    let t = 0;
    const rl = new RateLimiter(2, 1_000, () => t);
    assert.equal(rl.take("a").ok, true); // t=0
    t = 400;
    assert.equal(rl.take("a").ok, true); // t=400
    for (const at of [500, 600, 700, 999]) {
      t = at;
      assert.equal(rl.take("a").ok, false, `t=${at}`);
    }
    t = 1_000; // hit at t=0 has expired
    assert.equal(rl.take("a").ok, true);
    t = 1_100; // 400 and 1000 are still inside the window
    assert.equal(rl.take("a").ok, false);
    t = 1_400; // 400 expired
    assert.equal(rl.take("a").ok, true);
  });

  it("allows a full burst again once the whole window has passed", () => {
    let t = 0;
    const rl = new RateLimiter(3, 1_000, () => t);
    for (let i = 0; i < 3; i++) assert.equal(rl.take("a").ok, true);
    assert.equal(rl.take("a").ok, false);
    t = 10_000;
    for (let i = 0; i < 3; i++) assert.equal(rl.take("a").ok, true);
    assert.equal(rl.take("a").ok, false);
  });

  it("keeps keys independent", () => {
    let t = 0;
    const rl = new RateLimiter(1, 1_000, () => t);
    assert.equal(rl.take("a").ok, true);
    assert.equal(rl.take("a").ok, false);
    assert.equal(rl.take("b").ok, true);
    assert.equal(rl.take("b").ok, false);
    assert.equal(rl.take("c").ok, true);
  });

  it("still behaves after the periodic sweep drops idle keys", () => {
    let t = 0;
    const rl = new RateLimiter(1, 1_000, () => t);
    assert.equal(rl.take("old").ok, true);
    t = 5 * 60_000; // far beyond the 60 s sweep interval
    assert.equal(rl.take("new").ok, true);
    assert.equal(rl.take("old").ok, true);
    assert.equal(rl.take("old").ok, false);
  });
});

describe("clientIp", () => {
  const req = (headers: Record<string, string | string[] | undefined>, remoteAddress?: string): IncomingMessage =>
    ({ headers, socket: { remoteAddress } }) as unknown as IncomingMessage;

  it("ignores X-Forwarded-For and CF-Connecting-IP when trustProxy is 0", () => {
    const r = req({ "x-forwarded-for": "6.6.6.6", "cf-connecting-ip": "7.7.7.7" }, "10.0.0.1");
    assert.equal(clientIp(r, 0), "10.0.0.1");
  });

  it("falls back to the socket address, or 'unknown' when there is none", () => {
    assert.equal(clientIp(req({}, "10.0.0.1"), 1), "10.0.0.1");
    assert.equal(clientIp(req({}, "10.0.0.1"), 0), "10.0.0.1");
    assert.equal(clientIp(req({}, undefined), 0), "unknown");
    assert.equal(clientIp(req({}, undefined), 2), "unknown");
  });

  it("with trustProxy 1 prefers CF-Connecting-IP", () => {
    const r = req({ "cf-connecting-ip": " 7.7.7.7 ", "x-forwarded-for": "1.1.1.1, 2.2.2.2" }, "10.0.0.1");
    assert.equal(clientIp(r, 1), "7.7.7.7");
  });

  it("with trustProxy 1 otherwise takes the last X-Forwarded-For entry (the one the trusted proxy appended)", () => {
    assert.equal(clientIp(req({ "x-forwarded-for": "1.1.1.1, 2.2.2.2, 3.3.3.3" }, "10.0.0.1"), 1), "3.3.3.3");
    assert.equal(clientIp(req({ "x-forwarded-for": "3.3.3.3" }, "10.0.0.1"), 1), "3.3.3.3");
    // a client-forged leading entry cannot change the identity the proxy recorded
    assert.equal(clientIp(req({ "x-forwarded-for": "6.6.6.6, 9.9.9.9" }, "10.0.0.1"), 1), "9.9.9.9");
  });

  it("with trustProxy 2 takes the second entry from the right", () => {
    assert.equal(clientIp(req({ "x-forwarded-for": "1.1.1.1, 2.2.2.2, 3.3.3.3" }, "10.0.0.1"), 2), "2.2.2.2");
    assert.equal(clientIp(req({ "x-forwarded-for": "1.1.1.1, 2.2.2.2" }, "10.0.0.1"), 2), "1.1.1.1");
  });

  it("clamps to the leftmost entry when there are fewer hops than trusted", () => {
    assert.equal(clientIp(req({ "x-forwarded-for": "1.1.1.1" }, "10.0.0.1"), 2), "1.1.1.1");
    assert.equal(clientIp(req({ "x-forwarded-for": "1.1.1.1, 2.2.2.2" }, "10.0.0.1"), 5), "1.1.1.1");
  });

  it("falls back to the socket when the forwarding headers are empty or blank", () => {
    assert.equal(clientIp(req({ "x-forwarded-for": "" }, "10.0.0.1"), 1), "10.0.0.1");
    assert.equal(clientIp(req({ "x-forwarded-for": " , " }, "10.0.0.1"), 1), "10.0.0.1");
    assert.equal(clientIp(req({ "cf-connecting-ip": "  " }, "10.0.0.1"), 1), "10.0.0.1");
    // a blank CF header does not hide a good X-Forwarded-For
    assert.equal(clientIp(req({ "cf-connecting-ip": " ", "x-forwarded-for": "4.4.4.4" }, "10.0.0.1"), 1), "4.4.4.4");
  });

  it("accepts repeated headers delivered as arrays", () => {
    assert.equal(clientIp(req({ "x-forwarded-for": ["1.1.1.1", "2.2.2.2, 3.3.3.3"] }, "10.0.0.1"), 1), "3.3.3.3");
    assert.equal(clientIp(req({ "cf-connecting-ip": ["8.8.8.8", "9.9.9.9"] }, "10.0.0.1"), 1), "8.8.8.8");
  });

  it("keeps preferring CF-Connecting-IP at higher hop counts", () => {
    assert.equal(clientIp(req({ "cf-connecting-ip": "7.7.7.7", "x-forwarded-for": "1.1.1.1, 2.2.2.2" }, "10.0.0.1"), 2), "7.7.7.7");
  });
});

// ------------------------------------------------------------------------------------------------
// RunQueue
// ------------------------------------------------------------------------------------------------

describe("RunQueue", () => {
  const noop = (): void => undefined;
  const tick = (): Promise<void> => new Promise((resolve) => setImmediate(resolve));
  const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));
  const granted = (r: AcquireResult): (() => void) => {
    if (!r.ok) throw new Error(`expected a granted slot, got ${r.reason}`);
    return r.release;
  };
  /** Wraps a promise so tests can ask "has it settled yet?" without awaiting it. */
  const track = <T>(p: Promise<T>): { settled: () => boolean; promise: Promise<T> } => {
    let done = false;
    const promise = p.then((v) => {
      done = true;
      return v;
    });
    return { settled: () => done, promise };
  };
  const positions = (): { log: [number, number][]; cb: (position: number, ahead: number) => void; last: () => [number, number] | undefined } => {
    const log: [number, number][] = [];
    return { log, cb: (p, a) => log.push([p, a]), last: () => log.at(-1) };
  };

  it("runs up to maxActive at once and queues the rest", async () => {
    const q = new RunQueue(2, 5);
    const ac = new AbortController();
    const r1 = granted(await q.acquire(ac.signal, noop, 1_000));
    const r2 = granted(await q.acquire(ac.signal, noop, 1_000));
    assert.equal(q.running, 2);
    const third = track(q.acquire(ac.signal, noop, 1_000));
    await tick();
    assert.equal(third.settled(), false);
    assert.equal(q.running, 2);
    assert.equal(q.waiting, 1);
    r1();
    const r3 = granted(await third.promise);
    assert.equal(q.running, 2);
    assert.equal(q.waiting, 0);
    r2();
    r3();
    assert.equal(q.running, 0);
  });

  it("serves waiters in FIFO order and reports their positions", async () => {
    const q = new RunQueue(1, 5);
    const ac = new AbortController();
    const holder = granted(await q.acquire(ac.signal, noop, 1_000));
    const order: string[] = [];
    const pb = positions();
    const pc = positions();
    const pd = positions();
    const b = q.acquire(ac.signal, pb.cb, 5_000).then((r) => (order.push("b"), r));
    const c = q.acquire(ac.signal, pc.cb, 5_000).then((r) => (order.push("c"), r));
    const d = q.acquire(ac.signal, pd.cb, 5_000).then((r) => (order.push("d"), r));
    await tick();
    assert.equal(q.waiting, 3);
    assert.deepEqual(pb.last(), [1, 0]);
    assert.deepEqual(pc.last(), [2, 1]);
    assert.deepEqual(pd.last(), [3, 2]);

    holder(); // b gets the slot; c and d move up
    const releaseB = granted(await b);
    assert.deepEqual(pc.last(), [1, 0]);
    assert.deepEqual(pd.last(), [2, 1]);
    assert.equal(q.running, 1);

    releaseB();
    const releaseC = granted(await c);
    assert.deepEqual(pd.last(), [1, 0]);
    releaseC();
    const releaseD = granted(await d);
    releaseD();
    assert.deepEqual(order, ["b", "c", "d"]);
    assert.equal(q.running, 0);
    assert.equal(q.waiting, 0);
  });

  it("an aborted waiter leaves the queue and everyone behind it moves up", async () => {
    const q = new RunQueue(1, 5);
    const holderAc = new AbortController();
    const holder = granted(await q.acquire(holderAc.signal, noop, 1_000));
    const acB = new AbortController();
    const acC = new AbortController();
    const acD = new AbortController();
    const pb = positions();
    const pc = positions();
    const pd = positions();
    const b = q.acquire(acB.signal, pb.cb, 5_000);
    const c = q.acquire(acC.signal, pc.cb, 5_000);
    const d = q.acquire(acD.signal, pd.cb, 5_000);
    await tick();
    assert.deepEqual(pd.last(), [3, 2]);

    acC.abort();
    assert.deepEqual(await c, { ok: false, reason: "aborted" });
    assert.equal(q.waiting, 2);
    assert.deepEqual(pb.last(), [1, 0]);
    assert.deepEqual(pd.last(), [2, 1]);

    holder();
    const releaseB = granted(await b);
    assert.deepEqual(pd.last(), [1, 0]);
    releaseB();
    granted(await d)();
    assert.equal(q.running, 0);
    assert.equal(q.waiting, 0);
  });

  it("refuses an already-aborted signal immediately, even when a slot is free", async () => {
    const q = new RunQueue(1, 1);
    const ac = new AbortController();
    ac.abort();
    assert.deepEqual(await q.acquire(ac.signal, noop, 1_000), { ok: false, reason: "aborted" });
    assert.equal(q.running, 0);
    assert.equal(q.waiting, 0);
  });

  it("aborting a waiter that was already granted does nothing", async () => {
    const q = new RunQueue(1, 1);
    const holder = granted(await q.acquire(new AbortController().signal, noop, 1_000));
    const ac = new AbortController();
    const waiting = q.acquire(ac.signal, noop, 5_000);
    holder();
    const release = granted(await waiting);
    ac.abort();
    await tick();
    assert.equal(q.running, 1);
    release();
    assert.equal(q.running, 0);
  });

  it("times out a waiter with {ok:false, reason:'timeout'} and frees its place", async () => {
    const q = new RunQueue(1, 3);
    const ac = new AbortController();
    const holder = granted(await q.acquire(ac.signal, noop, 1_000));
    const pb = positions();
    const b = q.acquire(ac.signal, pb.cb, 20);
    const pc = positions();
    const c = q.acquire(ac.signal, pc.cb, 5_000);
    await tick();
    assert.deepEqual(pc.last(), [2, 1]);
    assert.deepEqual(await b, { ok: false, reason: "timeout" });
    assert.equal(q.waiting, 1);
    assert.deepEqual(pc.last(), [1, 0]); // c moved up when b timed out
    holder();
    granted(await c)();
    assert.equal(q.running, 0);
  });

  it("a waiter that is granted before its timeout is not timed out later", async () => {
    const q = new RunQueue(1, 1);
    const ac = new AbortController();
    const holder = granted(await q.acquire(ac.signal, noop, 1_000));
    const waiting = q.acquire(ac.signal, noop, 40);
    holder();
    const release = granted(await waiting);
    await sleep(80);
    assert.equal(q.running, 1);
    assert.equal(q.waiting, 0);
    release();
    assert.equal(q.running, 0);
  });

  it("reports 'full' when the waiting list is at max, and isFull() tracks it", async () => {
    const q = new RunQueue(1, 1);
    const ac = new AbortController();
    assert.equal(q.isFull(), false);
    const holder = granted(await q.acquire(ac.signal, noop, 1_000));
    assert.equal(q.isFull(), false); // one waiting place is still free
    const acB = new AbortController();
    const b = q.acquire(acB.signal, noop, 5_000);
    await tick();
    assert.equal(q.isFull(), true);
    assert.deepEqual(await q.acquire(ac.signal, noop, 1_000), { ok: false, reason: "full" });
    assert.equal(q.waiting, 1);
    acB.abort();
    assert.deepEqual(await b, { ok: false, reason: "aborted" });
    assert.equal(q.isFull(), false);
    holder();
    assert.equal(q.isFull(), false);
  });

  it("with no waiting places, a busy queue is immediately full", async () => {
    const q = new RunQueue(1, 0);
    const ac = new AbortController();
    assert.equal(q.isFull(), false);
    const holder = granted(await q.acquire(ac.signal, noop, 1_000));
    assert.equal(q.isFull(), true);
    assert.deepEqual(await q.acquire(ac.signal, noop, 1_000), { ok: false, reason: "full" });
    holder();
    assert.equal(q.isFull(), false);
  });

  it("is never full while a slot is free, whatever the waiting limit", async () => {
    const q = new RunQueue(2, 0);
    const ac = new AbortController();
    const a = granted(await q.acquire(ac.signal, noop, 1_000));
    assert.equal(q.isFull(), false);
    const b = granted(await q.acquire(ac.signal, noop, 1_000));
    assert.equal(q.isFull(), true);
    a();
    b();
  });

  it("release is idempotent: a second call neither frees a second slot nor wakes another waiter", async () => {
    const q = new RunQueue(1, 5);
    const ac = new AbortController();
    const first = granted(await q.acquire(ac.signal, noop, 1_000));
    const b = q.acquire(ac.signal, noop, 5_000);
    const c = track(q.acquire(ac.signal, noop, 5_000));
    await tick();
    first();
    first();
    first();
    const releaseB = granted(await b);
    await tick();
    assert.equal(q.running, 1);
    assert.equal(c.settled(), false);
    assert.equal(q.waiting, 1);
    releaseB();
    releaseB();
    granted(await c.promise)();
    assert.equal(q.running, 0);
    assert.equal(q.waiting, 0);
  });

  it("release grants the next waiter without letting running exceed maxActive", async () => {
    const q = new RunQueue(2, 5);
    const ac = new AbortController();
    const slots = [granted(await q.acquire(ac.signal, noop, 1_000)), granted(await q.acquire(ac.signal, noop, 1_000))];
    const waiters = [q.acquire(ac.signal, noop, 5_000), q.acquire(ac.signal, noop, 5_000), q.acquire(ac.signal, noop, 5_000)];
    await tick();
    let peak = q.running;
    const releases: (() => void)[] = [...slots];
    for (const w of waiters) {
      releases.shift()?.();
      releases.push(granted(await w));
      peak = Math.max(peak, q.running);
    }
    assert.equal(peak, 2);
    for (const r of releases) r();
    assert.equal(q.running, 0);
  });
});

// ------------------------------------------------------------------------------------------------
// SessionStore
// ------------------------------------------------------------------------------------------------

describe("SessionStore", () => {
  const FORM: FormInput = { place: "Newark, NJ", ageBand: "any", interests: "Severance", titleCount: 5 };
  const make = (clock: { t: number }): Session => newSession(FORM, "fixtures", clock.t);

  it("newSession creates unique 32-char lowercase hex ids and an idle session", () => {
    const a = newSession(FORM, "fixtures", 5);
    const b = newSession(FORM, "live", 5);
    assert.match(a.id, /^[a-f0-9]{32}$/);
    assert.notEqual(a.id, b.id);
    assert.equal(a.busy, false);
    assert.equal(a.createdAt, 5);
    assert.equal(a.lastUsed, 5);
    assert.equal(a.mode, "fixtures");
    assert.equal(b.mode, "live");
    assert.equal(a.followUps, 0);
    assert.equal(a.pending.size, 0);
  });

  it("returns a session until its TTL elapses, then evicts it", () => {
    const clock = { t: 0 };
    const store = new SessionStore(1_000, 10, () => clock.t);
    const s = make(clock);
    store.add(s);
    assert.equal(store.get(s.id), s);
    clock.t = 1_000; // exactly the TTL: still alive (eviction is strictly greater than)
    assert.equal(store.get(s.id), s);
    clock.t = 1_001;
    assert.equal(store.get(s.id), undefined);
    assert.equal(store.size, 0);
    assert.equal(store.get("unknown"), undefined);
  });

  it("measures the TTL from lastUsed, so activity keeps a session alive", () => {
    const clock = { t: 0 };
    const store = new SessionStore(1_000, 10, () => clock.t);
    const s = make(clock);
    store.add(s);
    clock.t = 900;
    s.lastUsed = clock.t;
    clock.t = 1_800;
    assert.equal(store.get(s.id), s);
    clock.t = 1_901;
    assert.equal(store.get(s.id), undefined);
  });

  it("never expires a busy session, and expires it once it is idle again", () => {
    const clock = { t: 0 };
    const store = new SessionStore(1_000, 10, () => clock.t);
    const s = make(clock);
    s.busy = true;
    store.add(s);
    clock.t = 10_000;
    assert.equal(store.get(s.id), s);
    store.sweep();
    assert.equal(store.size, 1);
    s.busy = false; // lastUsed is still 0, so it is long overdue
    assert.equal(store.get(s.id), undefined);
  });

  it("add() sweeps expired sessions and sweep() removes only the idle expired ones", () => {
    const clock = { t: 0 };
    const store = new SessionStore(1_000, 10, () => clock.t);
    const old = make(clock);
    const busy = make(clock);
    busy.busy = true;
    store.add(old);
    store.add(busy);
    clock.t = 5_000;
    const fresh = make(clock);
    store.add(fresh);
    assert.equal(store.size, 2);
    assert.equal(store.get(old.id), undefined);
    assert.equal(store.get(busy.id), busy);
    assert.equal(store.get(fresh.id), fresh);
  });

  it("at the cap, evicts the least recently used idle session", () => {
    const clock = { t: 0 };
    const store = new SessionStore(60_000, 3, () => clock.t);
    const sessions: Session[] = [];
    for (let i = 0; i < 3; i++) {
      clock.t = i * 10;
      const s = make(clock);
      sessions.push(s);
      store.add(s);
    }
    clock.t = 100;
    sessions[0]!.lastUsed = 100; // touched: s1 is now the oldest
    const newest = make(clock);
    store.add(newest);
    assert.equal(store.size, 3);
    assert.equal(store.get(sessions[1]!.id), undefined);
    assert.ok(store.get(sessions[0]!.id));
    assert.ok(store.get(sessions[2]!.id));
    assert.ok(store.get(newest.id));
  });

  it("at the cap, never evicts a busy session even if it is the oldest", () => {
    const clock = { t: 0 };
    const store = new SessionStore(60_000, 3, () => clock.t);
    const sessions: Session[] = [];
    for (let i = 0; i < 3; i++) {
      clock.t = i * 10;
      const s = make(clock);
      sessions.push(s);
      store.add(s);
    }
    sessions[0]!.busy = true; // the oldest, but working
    clock.t = 100;
    const newest = make(clock);
    store.add(newest);
    assert.equal(store.size, 3);
    assert.ok(store.get(sessions[0]!.id), "busy session must survive");
    assert.equal(store.get(sessions[1]!.id), undefined, "next-oldest idle session goes instead");
    assert.ok(store.get(sessions[2]!.id));
    assert.ok(store.get(newest.id));
  });

  it("when every session is busy the new one is still admitted and nothing busy is dropped", () => {
    const clock = { t: 0 };
    const store = new SessionStore(60_000, 2, () => clock.t);
    const busy = [make(clock), make(clock)];
    for (const s of busy) {
      s.busy = true;
      store.add(s);
    }
    const extra = make(clock);
    store.add(extra);
    assert.equal(store.size, 3); // the cap is soft while everything is busy
    for (const s of [...busy, extra]) assert.ok(store.get(s.id));
  });
});

// ------------------------------------------------------------------------------------------------
// Snapshot drift: the checked-in TOOLS_SNAPSHOT must equal what the installed harness really publishes.
// ------------------------------------------------------------------------------------------------

describe("TOOLS_SNAPSHOT drift", () => {
  it("matches tools/list from the installed @qloo/qloo-harness (names, titles, descriptions, input schemas)", { timeout: 20_000 }, async () => {
    const env: NodeJS.ProcessEnv = { ...process.env };
    delete env["QLOO_API_KEY"];
    delete env["QLOO_BIN"];
    const client = new McpQlooClient(resolveQlooCommand(env), env);
    try {
      const live = await client.listTools();
      const hint = "TOOLS_SNAPSHOT is out of date; run `npm run docs:tools` to regenerate it.";
      const liveByName = new Map(live.map((t) => [t.name, t]));
      assert.deepEqual([...liveByName.keys()].sort(), TOOLS_SNAPSHOT.map((t) => t.name).sort(), `tool names differ. ${hint}`);
      for (const snap of TOOLS_SNAPSHOT) {
        const real = liveByName.get(snap.name);
        assert.ok(real, snap.name);
        assert.equal(real.description, snap.description, `${snap.name}: description differs. ${hint}`);
        assert.equal(real.title, snap.title, `${snap.name}: title differs. ${hint}`);
        assert.deepEqual(real.inputSchema, snap.inputSchema, `${snap.name}: inputSchema differs. ${hint}`);
      }
    } finally {
      await client.close();
    }
  });

  it("records the harness version that is actually installed", () => {
    const pkgPath = fileURLToPath(new URL("../node_modules/@qloo/qloo-harness/package.json", import.meta.url));
    const installed = (JSON.parse(readFileSync(pkgPath, "utf8")) as { version: string }).version;
    assert.equal(TOOLS_SNAPSHOT_HARNESS_VERSION, installed);
  });
});
