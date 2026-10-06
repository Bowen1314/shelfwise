#!/usr/bin/env node
// A fake `qloo mcp` for tests: newline-delimited JSON-RPC over stdio, protocol 2024-11-05, the same result
// envelope the real harness uses, and its OWN tiny dataset (not the product's sample fixtures).
//
// Magic inputs (case-insensitive, in `signals` / `entity` / `options`):
//   "Ambiguo"     -> needs_input (ambiguous, two candidates); the id "amb-book" resolves to a book signal
//   "Notfoundo"   -> needs_input (not_found)
//   "Nothingness" -> a real signal that has no books: status empty
//   "Flaky"       -> first call fails with a RETRYABLE error, later calls succeed
//   "Brokenly"    -> always fails with a NON-retryable error
//   "Authfail"    -> error QLOO_AUTH (non-retryable, fatal)
//   "Partialo"    -> status partial (+ warning), with books
//   "Degradedo"   -> status degraded (+ warning), with books
//   "Slowpoke"    -> answers after 3s (timeout tests)
//   "Crashy"      -> the process exits mid-call, once (marker file in FAKE_QLOO_CRASH_MARKER)
//   "Envprobe"    -> describe: the summary lists which secret env vars this process can see
// Env: FAKE_QLOO_LOG = file; every tools/call appends one JSON line {tool, args}.
import { appendFileSync, existsSync, writeFileSync } from "node:fs";
import { createInterface } from "node:readline";
import { TOOLS_SNAPSHOT } from "./tools.mjs";

const SIGNALS = {
  severance: { id: "sig-severance", name: "Severance", type: "urn:entity:tv_show", books: ["bk-piranesi", "bk-station-eleven", "bk-klara", "bk-memory"] },
  "the bear": { id: "sig-bear", name: "The Bear", type: "urn:entity:tv_show", books: ["bk-kitchen", "bk-hmart", "bk-piranesi"] },
  "phoebe bridgers": { id: "sig-phoebe", name: "Phoebe Bridgers", type: "urn:entity:artist", books: ["bk-hmart", "bk-klara"] },
  nothingness: { id: "sig-nothing", name: "Nothingness", type: "urn:entity:tv_show", books: [] },
  flaky: { id: "sig-flaky", name: "Flaky", type: "urn:entity:tv_show", books: ["bk-piranesi", "bk-memory"] },
  partialo: { id: "sig-partial", name: "Partialo", type: "urn:entity:tv_show", books: ["bk-klara", "bk-kitchen"] },
  degradedo: { id: "sig-degraded", name: "Degradedo", type: "urn:entity:tv_show", books: ["bk-memory", "bk-hmart"] },
  slowpoke: { id: "sig-slow", name: "Slowpoke", type: "urn:entity:tv_show", books: ["bk-piranesi"] },
  brokenly: { id: "sig-broken", name: "Brokenly", type: "urn:entity:tv_show", books: ["bk-piranesi"] },
  authfail: { id: "sig-auth", name: "Authfail", type: "urn:entity:tv_show", books: ["bk-piranesi"] },
  crashy: { id: "sig-crashy", name: "Crashy", type: "urn:entity:tv_show", books: ["bk-piranesi"] },
  "amb-book": { id: "amb-book", name: "Ambiguo", type: "urn:entity:book", books: ["bk-station-eleven", "bk-hmart"] },
  "amb-film": { id: "amb-film", name: "Ambiguo", type: "urn:entity:movie", books: ["bk-memory"] },
};
const BY_ID = Object.fromEntries(Object.values(SIGNALS).map((s) => [s.id, s]));
const BOOKS = [
  { id: "bk-piranesi", name: "Piranesi", year: 2020 },
  { id: "bk-station-eleven", name: "Station Eleven", year: 2014 },
  { id: "bk-klara", name: "Klara and the Sun", year: 2021 },
  { id: "bk-kitchen", name: "Kitchen Confidential", year: 2000 },
  { id: "bk-hmart", name: "Crying in H Mart", year: 2021 },
  { id: "bk-memory", name: "The Memory Police", year: 1994 },
];
const BOOK_BY_ID = Object.fromEntries(BOOKS.map((b) => [b.id, b]));
const BOOK_BY_NAME = Object.fromEntries(BOOKS.map((b) => [b.name.toLowerCase(), b]));
const norm = (s) => String(s).trim().toLowerCase();

const counters = new Map();
const bump = (key) => {
  const n = (counters.get(key) ?? 0) + 1;
  counters.set(key, n);
  return n;
};

const envelope = (operation, payload) => ({
  schema_version: "1.0-preview.1",
  operation,
  status: "ok",
  ...payload,
  provenance: { requests: [{ method: "GET", path: "/fake", query: {} }] },
});
const needsInput = (operation, issues) => envelope(operation, { status: "needs_input", summary: "Choose or correct the unresolved Qloo inputs.", resolution: { issues }, results: [] });
const err = (operation, code, summary, retryable) =>
  envelope(operation, { status: "error", summary, results: [], result_count: 0, error: { code, layer: "fake", retryable, recovery: retryable ? "Retry." : "Fix the request." } });

function resolveOne(input, field) {
  const key = norm(input);
  if (key === "ambiguo") {
    return {
      issue: {
        input,
        kind: "ambiguous",
        input_kind: "entity",
        field,
        candidates: [
          { id: "amb-book", name: "Ambiguo", type: "urn:entity:book", rank: 1, score: 0.9, popularity: 0.5, release_year: 1990 },
          { id: "amb-film", name: "Ambiguo", type: "urn:entity:movie", rank: 2, score: 0.8, popularity: 0.4, release_year: 2011 },
        ],
      },
    };
  }
  if (key === "notfoundo") return { issue: { input, kind: "not_found", input_kind: "entity", field } };
  const sig = SIGNALS[key] ?? BY_ID[key];
  if (sig) return { entity: sig };
  const book = BOOK_BY_NAME[key] ?? BOOK_BY_ID[key];
  if (book) return { entity: { id: book.id, name: book.name, type: "urn:entity:book", books: [] } };
  return { issue: { input, kind: "not_found", input_kind: "entity", field } };
}

function resolveMany(inputs, field) {
  const entities = [];
  const issues = [];
  for (const input of Array.isArray(inputs) ? inputs : inputs === undefined ? [] : [inputs]) {
    const r = resolveOne(input, field);
    if (r.issue) issues.push(r.issue);
    else entities.push({ input, entity: r.entity });
  }
  return { entities, issues };
}

const interpreted = (list) => list.map(({ input, entity }) => ({ input, entityId: entity.id, name: entity.name, type: entity.type, match: "exact" }));
// Like live insights rows: `type` is the bare "urn:entity" and the real type is in `subtype`.
const bookRow = (b, affinity) => ({
  entity_id: b.id,
  name: b.name,
  type: "urn:entity",
  subtype: "urn:entity:book",
  popularity: 0.5,
  affinity,
  properties: { release_year: b.year, description: `${b.name} (fake test record)` },
});

function recommend(args) {
  if (args.target_type !== "book") return envelope("recommend", { status: "empty", summary: "Only books in the fake dataset.", results: [], result_count: 0 });
  const { entities, issues } = resolveMany(args.signals, "signals");
  if (issues.length) return needsInput("recommend", issues);
  const keys = entities.map((e) => norm(e.input));
  if (keys.includes("authfail")) return err("recommend", "QLOO_AUTH", "Missing Qloo credentials.", false);
  if (keys.includes("brokenly")) return err("recommend", "QLOO_UPSTREAM_REQUEST", "Qloo rejected the request (400).", false);
  if (keys.includes("flaky") && bump("flaky") === 1) return err("recommend", "QLOO_UPSTREAM_TIMEOUT", "Qloo timed out.", true);
  const ids = [...new Set(entities.flatMap((e) => e.entity.books))];
  const rows = ids.slice(0, args.limit ?? 10).map((id, i) => bookRow(BOOK_BY_ID[id], Number((0.9 - i * 0.07).toFixed(2))));
  const status = rows.length === 0 ? "empty" : keys.includes("partialo") ? "partial" : keys.includes("degradedo") ? "degraded" : "ok";
  return envelope("recommend", {
    status,
    summary: rows.length ? `Found ${rows.length} fake books.` : "No fake books for these signals.",
    interpretation: { target_type: "urn:entity:book", signals: interpreted(entities), ...(args.signal_location ? { signal_location: args.signal_location } : {}), ...(args.demographic ? { demographic: { input: args.demographic } } : {}) },
    results: rows,
    result_count: rows.length,
    ...(status === "partial" || status === "degraded" ? { warnings: [`Some upstream requests were ${status}.`] } : {}),
  });
}

function rank(args) {
  const opts = resolveMany(args.options, "options");
  const sig = resolveMany(args.signals, "signals");
  const issues = [...opts.issues, ...sig.issues];
  if (issues.length) return needsInput("rank", issues);
  const liked = new Set(sig.entities.flatMap((e) => e.entity.books));
  const rows = opts.entities
    .map(({ entity }) => ({ entity, s: liked.has(entity.id) ? 0.8 : 0.3 }))
    .sort((a, b) => b.s - a.s)
    .map(({ entity, s }) => bookRow(BOOK_BY_ID[entity.id] ?? { id: entity.id, name: entity.name, year: 2000 }, s));
  return envelope("rank", { summary: `Ranked ${rows.length} fake books.`, interpretation: { option_type: "urn:entity:book", options: interpreted(opts.entities), signals: interpreted(sig.entities) }, results: rows, result_count: rows.length });
}

// Names the env-leak tests look for in this process (never their values).
const PROBE_VARS = ["QLOO_API_KEY", "LLM_API_KEY", "NEBIUS_API_KEY", "OPENAI_API_KEY", "ANOTHER_TOOL_TOKEN", "AWS_SECRET_ACCESS_KEY", "HARMLESS_SETTING"];

function describe(args) {
  if (norm(args.entity) === "envprobe") {
    const seen = PROBE_VARS.map((k) => `${k}:${process.env[k] ? "present" : "absent"}`).join(" ");
    return envelope("describe", { summary: seen, results: [], result_count: 0 });
  }
  const r = resolveOne(args.entity, "entity");
  if (r.issue) return needsInput("describe", [r.issue]);
  return envelope("describe", { summary: `Resolved ${r.entity.name}.`, interpretation: { entity: interpreted([{ input: args.entity, entity: r.entity }])[0] }, results: [], result_count: 0 });
}

function wherePopular(args) {
  const r = resolveOne(args.entity, "entity");
  if (r.issue) return needsInput("where_popular", [r.issue]);
  const interp = { entity: interpreted([{ input: args.entity, entity: r.entity }])[0], within: args.within };
  if (norm(args.within) === "nowhereville") return envelope("where_popular", { status: "empty", summary: "No heat data there.", interpretation: interp, results: [], result_count: 0 });
  const results = [0.71, 0.64, 0.5].map((a, i) => ({ location: { latitude: 40.7 + i * 0.01, longitude: -74.1 + i * 0.01 }, query: { affinity: a } }));
  // The live harness sends no `summary` on a successful heatmap.
  return envelope("where_popular", { interpretation: interp, results, result_count: results.length });
}

// The live /v2/trending answers HTTP 400 for these types; anything else in the schema enum would be accepted.
const TRENDABLE = ["tv_show", "movie", "artist", "podcast", "person", "brand"];

function trends(args) {
  if (!TRENDABLE.includes(args.entity_type)) {
    return err("trends", "QLOO_UPSTREAM_REQUEST", "Qloo rejected the request (400): filter.type must be one of urn:entity:actor, artist, brand, movie, person, podcast, tv_show.", false);
  }
  const ents = resolveMany(args.entities, "entities");
  if (ents.issues.length) return needsInput("trends", ents.issues);
  const series = ents.entities.map(({ input, entity }) => ({
    entity: interpreted([{ input, entity }])[0],
    points: Array.from({ length: 12 }, (_, i) => ({ date: `2026-${String(i + 1).padStart(2, "0")}-01`, popularity: Number((0.3 + i * 0.03).toFixed(3)) })),
  }));
  return envelope("trends", { interpretation: { entity_type: `urn:entity:${args.entity_type}`, start_date: args.start_date, end_date: args.end_date }, series, result_count: series.length });
}

function compare(args) {
  const a = resolveMany(args.group_a, "group_a");
  const b = resolveMany(args.group_b, "group_b");
  if (a.issues.length || b.issues.length) return needsInput("compare_audiences", [...a.issues, ...b.issues]);
  const ids = a.entities.flatMap((e) => e.entity.books).filter((id) => b.entities.some((e) => e.entity.books.includes(id)));
  const rows = [...new Set(ids)].map((id, i) => bookRow(BOOK_BY_ID[id], Number((0.8 - i * 0.1).toFixed(2))));
  return envelope("compare_audiences", { status: rows.length ? "ok" : "empty", summary: rows.length ? `${rows.length} fake books both groups reach.` : "Nothing shared.", results: { entities: rows } });
}

async function callTool(name, args) {
  if (JSON.stringify(args).toLowerCase().includes('"slowpoke"')) await new Promise((r) => setTimeout(r, 3000));
  if (JSON.stringify(args).toLowerCase().includes('"crashy"')) {
    const marker = process.env.FAKE_QLOO_CRASH_MARKER;
    if (marker && !existsSync(marker)) {
      writeFileSync(marker, "crashed");
      process.exit(1);
    }
  }
  switch (name) {
    case "qloo_recommend":
      return recommend(args);
    case "qloo_rank":
      return rank(args);
    case "qloo_describe":
      return describe(args);
    case "qloo_where_popular":
      return wherePopular(args);
    case "qloo_trends":
      return trends(args);
    case "qloo_compare_audiences":
      return compare(args);
    case "qloo_capabilities":
      return { schema_version: "1.0-preview.1", adapter: { ready: Boolean(process.env.QLOO_API_KEY) } };
    default:
      return envelope(name.replace(/^qloo_/, ""), { status: "empty", summary: "Not modelled by the fake.", results: [], result_count: 0 });
  }
}

const send = (msg) => process.stdout.write(`${JSON.stringify(msg)}\n`);
const rl = createInterface({ input: process.stdin });
rl.on("line", async (line) => {
  if (!line.trim()) return;
  let req;
  try {
    req = JSON.parse(line);
  } catch {
    return;
  }
  if (req.id === undefined) return; // notification
  try {
    if (req.method === "initialize") {
      send({ jsonrpc: "2.0", id: req.id, result: { protocolVersion: req.params?.protocolVersion ?? "2024-11-05", capabilities: { tools: {} }, serverInfo: { name: "fake-qloo", version: "0.0.0" } } });
    } else if (req.method === "tools/list") {
      send({ jsonrpc: "2.0", id: req.id, result: { tools: TOOLS_SNAPSHOT } });
    } else if (req.method === "tools/call") {
      const { name, arguments: args = {} } = req.params ?? {};
      if (process.env.FAKE_QLOO_LOG) appendFileSync(process.env.FAKE_QLOO_LOG, `${JSON.stringify({ tool: name, args })}\n`);
      const result = await callTool(name, args);
      const isError = result.status === "error";
      send({ jsonrpc: "2.0", id: req.id, result: { content: [{ type: "text", text: JSON.stringify(result) }], structuredContent: result, isError } });
    } else if (req.method === "ping") {
      send({ jsonrpc: "2.0", id: req.id, result: {} });
    } else {
      send({ jsonrpc: "2.0", id: req.id, error: { code: -32601, message: `Method not found: ${req.method}` } });
    }
  } catch (e) {
    send({ jsonrpc: "2.0", id: req.id, error: { code: -32603, message: String(e?.message ?? e) } });
  }
});
rl.on("close", () => process.exit(0));
