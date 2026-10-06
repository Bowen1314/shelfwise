import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { AgentEvent, FormInput, Report, ToolResultView } from "@shared/types";
import { initialRunState, runReducer, type RunAction, type RunState } from "../src/lib/reduce";
import {
  clearRecentRuns,
  loadRecentRuns,
  MAX_RECENT_RUNS,
  parseRecentRuns,
  RAW_NOT_KEPT,
  RECENT_RUNS_KEY,
  recentRunFrom,
  relativeTime,
  removeRecentRun,
  saveRecentRun,
  trailCalls,
  type RecentRun,
  type StorageLike,
} from "../src/lib/recentRuns";

// ---------------------------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------------------------

const RAW_MARKER = "raw-envelope-marker";

function report(version = 1, place = "Newark, NJ"): Report {
  const cite = { callId: "c1", tool: "qloo_recommend", label: "result 1 of 8" };
  const book = { handle: "e2", entityId: "q-2", name: "Piranesi", type: "book", year: 2020 };
  return {
    version,
    createdAt: "2026-10-06T10:00:00.000Z",
    sample: true,
    place,
    audience: "Adults",
    bridgeShelf: [
      { id: "b1", loved: [{ handle: "e1", entityId: "q-1", name: "Severance" }], book, why: "Strange offices.", cites: [cite], reduced: false },
    ],
    buyList: [
      {
        rank: 1,
        book,
        rationale: "Fits the audience.",
        evidence: { matchedSignals: [], recommendations: [{ callId: "c1", position: 1, of: 8 }], reduced: false },
        cites: [cite],
      },
    ],
    programmes: [
      { id: "p1", kind: "book_club", title: "Odd jobs", description: "A club.", books: [book], signals: [], cites: [cite] },
    ],
    notes: [{ kind: "info", text: "A note." }],
  };
}

function result(callId: string): ToolResultView {
  return {
    callId,
    tool: "qloo_recommend",
    status: "ok",
    summary: "8 results",
    durationMs: 12,
    cached: false,
    sample: true,
    resolved: [],
    requests: [{ path: "/v2/insights", query: {} }],
    resultCount: 8,
    preview: [{ name: "Piranesi" }],
    warnings: [],
    raw: { marker: RAW_MARKER, padding: "x".repeat(200) },
  };
}

function slim(full: ToolResultView): Omit<ToolResultView, "raw"> {
  const { raw: _raw, ...rest } = full;
  return rest;
}

function run(sessionId: string, savedAt = 1_000, version = 1): RecentRun {
  return {
    sessionId,
    savedAt,
    place: `Place ${sessionId}`,
    interests: "Severance, The Bear",
    audience: "Adults",
    titleCount: 8,
    report: report(version),
    calls: [
      {
        call: { callId: "c1", tool: "qloo_recommend", args: { signals: ["Severance"] }, label: "Recommend books" },
        result: slim(result("c1")),
        retries: [],
        step: 1,
        turn: 0,
      },
    ],
    turns: [{ label: "Your request" }],
  };
}

interface FakeStorage extends StorageLike {
  data: Map<string, string>;
  setCalls: number;
}

/** A Map-backed Storage. `limit` caps the stored characters and throws QuotaExceededError beyond it. */
function fakeStorage(options: { limit?: number; throwOnGet?: boolean; throwOnSet?: boolean; throwOnRemove?: boolean } = {}): FakeStorage {
  const data = new Map<string, string>();
  const storage: FakeStorage = {
    data,
    setCalls: 0,
    getItem(key) {
      if (options.throwOnGet) throw new DOMException("blocked", "SecurityError");
      return data.get(key) ?? null;
    },
    setItem(key, value) {
      storage.setCalls += 1;
      if (options.throwOnSet) throw new DOMException("blocked", "SecurityError");
      if (options.limit !== undefined && value.length > options.limit) throw new DOMException("full", "QuotaExceededError");
      data.set(key, value);
    },
    removeItem(key) {
      if (options.throwOnRemove) throw new DOMException("blocked", "SecurityError");
      data.delete(key);
    },
  };
  return storage;
}

const ids = (runs: RecentRun[]) => runs.map((entry) => entry.sessionId);

// ---------------------------------------------------------------------------------------------
// Storage
// ---------------------------------------------------------------------------------------------

describe("recent runs storage", () => {
  it("keeps the newest first and at most ten", () => {
    const storage = fakeStorage();
    for (let i = 1; i <= 12; i++) saveRecentRun(run(`s${i}`, i), storage);
    const runs = loadRecentRuns(storage);
    assert.equal(runs.length, MAX_RECENT_RUNS);
    assert.deepEqual(ids(runs), ["s12", "s11", "s10", "s9", "s8", "s7", "s6", "s5", "s4", "s3"]);
  });

  it("returns what it stored, which reads back the same", () => {
    const storage = fakeStorage();
    const shown = saveRecentRun(run("s1"), storage);
    assert.deepEqual(shown, loadRecentRuns(storage));
    assert.equal(shown[0]?.report.sample, true);
  });

  it("dedupes by session: a follow-up replaces the entry and moves it to the top", () => {
    const storage = fakeStorage();
    saveRecentRun(run("s1", 1, 1), storage);
    saveRecentRun(run("s2", 2, 1), storage);
    saveRecentRun(run("s1", 3, 2), storage);
    const runs = loadRecentRuns(storage);
    assert.deepEqual(ids(runs), ["s1", "s2"]);
    assert.equal(runs[0]?.report.version, 2);
    assert.equal(runs[0]?.savedAt, 3);
  });

  it("reads duplicate sessions in stored data once, keeping the first", () => {
    const storage = fakeStorage();
    storage.data.set(RECENT_RUNS_KEY, JSON.stringify([run("s1", 5, 2), run("s1", 4, 1)]));
    const runs = loadRecentRuns(storage);
    assert.deepEqual(ids(runs), ["s1"]);
    assert.equal(runs[0]?.report.version, 2);
  });

  it("removes one run, and clears all", () => {
    const storage = fakeStorage();
    saveRecentRun(run("s1"), storage);
    saveRecentRun(run("s2"), storage);
    assert.deepEqual(ids(removeRecentRun("s1", storage)), ["s2"]);
    assert.deepEqual(ids(loadRecentRuns(storage)), ["s2"]);
    assert.deepEqual(clearRecentRuns(storage), []);
    assert.equal(storage.data.has(RECENT_RUNS_KEY), false);
    assert.deepEqual(loadRecentRuns(storage), []);
  });

  it("reads corrupt JSON and non-list values as an empty list", () => {
    for (const stored of ["{not json", "", "null", "42", '"text"', '{"sessionId":"s1"}', "true"]) {
      const storage = fakeStorage();
      storage.data.set(RECENT_RUNS_KEY, stored);
      assert.deepEqual(loadRecentRuns(storage), [], stored);
    }
    assert.deepEqual(parseRecentRuns(null), []);
  });

  it("skips entries with the wrong shape and keeps the good ones", () => {
    const good = run("good");
    const badNote = { ...run("bad-note"), report: { ...report(), notes: [{ kind: "shout", text: "?" }] } };
    const badCard = { ...run("bad-card"), report: { ...report(), bridgeShelf: [{ id: "b1", why: "no book" }] } };
    const badBuy = { ...run("bad-buy"), report: { ...report(), buyList: [{ rank: 1, book: { name: "x", handle: "e" } }] } };
    const stored = [
      null,
      "s1",
      42,
      [],
      { sessionId: 7 },
      { ...run("no-report"), report: null },
      { ...run("no-time"), savedAt: "yesterday" },
      { ...run(""), sessionId: "" },
      badNote,
      badCard,
      badBuy,
      good,
    ];
    const storage = fakeStorage();
    storage.data.set(RECENT_RUNS_KEY, JSON.stringify(stored));
    assert.deepEqual(ids(loadRecentRuns(storage)), ["good"]);
  });

  it("keeps a run whose trail is damaged, dropping only the bad trail entries", () => {
    const entry = run("s1");
    const damaged = { ...entry, calls: [...entry.calls, { call: { callId: "c2" }, result: null }, "junk"], turns: "nope" };
    const storage = fakeStorage();
    storage.data.set(RECENT_RUNS_KEY, JSON.stringify([damaged]));
    const [loaded] = loadRecentRuns(storage);
    assert.ok(loaded);
    assert.deepEqual(
      loaded.calls.map((c) => c.call.callId),
      ["c1"],
    );
    assert.deepEqual(loaded.turns, []);
  });

  it("never throws when storage throws on read or write, and still lists the run for this page", () => {
    const blocked = fakeStorage({ throwOnGet: true, throwOnSet: true, throwOnRemove: true });
    assert.deepEqual(loadRecentRuns(blocked), []);
    const first = saveRecentRun(run("s1"), blocked);
    assert.deepEqual(ids(first), ["s1"]);
    const second = saveRecentRun(run("s2"), blocked, first);
    assert.deepEqual(ids(second), ["s2", "s1"]);
    assert.deepEqual(ids(removeRecentRun("s1", blocked, second)), ["s2"]);
    assert.deepEqual(clearRecentRuns(blocked), []);
  });

  it("never throws when storage is missing", () => {
    assert.deepEqual(loadRecentRuns(null), []);
    assert.deepEqual(ids(saveRecentRun(run("s1"), null)), ["s1"]);
    assert.deepEqual(removeRecentRun("s1", null), []);
    assert.deepEqual(clearRecentRuns(null), []);
  });

  it("works when only writing throws", () => {
    const storage = fakeStorage({ throwOnSet: true });
    storage.data.set(RECENT_RUNS_KEY, JSON.stringify([run("old")]));
    assert.deepEqual(ids(saveRecentRun(run("new"), storage)), ["new", "old"]);
    assert.equal(storage.setCalls, 1, "a non-quota failure is not retried");
  });

  it("on QuotaExceededError drops the oldest entries until the list fits", () => {
    const one = JSON.stringify([run("s0")]).length;
    const storage = fakeStorage({ limit: one * 3 });
    for (let i = 1; i <= 3; i++) saveRecentRun(run(`s${i}`, i), storage);
    assert.deepEqual(ids(loadRecentRuns(storage)), ["s3", "s2", "s1"]);
    storage.setCalls = 0;
    const shown = saveRecentRun(run("s4", 4), storage);
    assert.deepEqual(ids(shown), ["s4", "s3", "s2"]);
    assert.deepEqual(ids(loadRecentRuns(storage)), ["s4", "s3", "s2"]);
    assert.equal(storage.setCalls, 2);
  });

  it("gives up after a bounded number of attempts when even one entry does not fit", () => {
    const storage = fakeStorage({ limit: 10 });
    const current = Array.from({ length: 9 }, (_, i) => run(`old${i}`, i));
    storage.data.set(RECENT_RUNS_KEY, JSON.stringify(current));
    const shown = saveRecentRun(run("new"), storage);
    assert.equal(shown[0]?.sessionId, "new", "the page still lists the new run");
    assert.ok(storage.setCalls <= MAX_RECENT_RUNS, `${storage.setCalls} attempts`);
    assert.equal(storage.data.get(RECENT_RUNS_KEY), JSON.stringify(current), "the old list is left as it was");
  });
});

// ---------------------------------------------------------------------------------------------
// What gets saved
// ---------------------------------------------------------------------------------------------

const form: FormInput = { place: "Newark, NJ", ageBand: "any", interests: "Severance", titleCount: 8 };
const request = { place: form.place, interests: form.interests, audience: "Whole community", titleCount: 8 };
const ev = (event: AgentEvent): RunAction => ({ type: "event", event });
const fold = (actions: RunAction[], from: RunState = initialRunState) => actions.reduce(runReducer, from);
const done = (reason: "completed" | "awaiting_input" | "error" | "max_steps" | "aborted"): RunAction =>
  ev({ type: "done", reason, steps: 3, toolCalls: 1 });

const started: RunAction[] = [
  { type: "submit", request: { input: { kind: "form", form } } },
  ev({ type: "session", sessionId: "s1", runId: "r1", mode: "fixtures" }),
  ev({ type: "started" }),
  ev({ type: "tool_call", call: { callId: "c1", tool: "qloo_recommend", args: {}, label: "Recommend" } }),
  ev({ type: "tool_result", result: result("c1") }),
];

describe("recentRunFrom", () => {
  it("saves a run that completed with a report, without the raw envelopes", () => {
    const state = fold([...started, ev({ type: "report", report: report() }), done("completed")]);
    const saved = recentRunFrom(state, request, 42);
    assert.ok(saved);
    assert.equal(saved.sessionId, "s1");
    assert.equal(saved.savedAt, 42);
    assert.equal(saved.audience, "Adults", "the audience the report was built for, not the form's label");
    assert.equal(saved.titleCount, 8);
    assert.equal(saved.calls.length, 1);
    assert.equal(saved.calls[0]?.result && "raw" in saved.calls[0].result, false);

    const storage = fakeStorage();
    saveRecentRun(saved, storage);
    const json = storage.data.get(RECENT_RUNS_KEY) ?? "";
    assert.equal(json.includes(RAW_MARKER), false, "raw envelopes are not stored");
    assert.equal(json.includes("8 results"), true, "the rest of the trail is");
  });

  it("gives reopened trail entries a note in place of the raw envelope", () => {
    const [entry] = trailCalls(run("s1"));
    assert.equal(entry?.result?.raw, RAW_NOT_KEPT);
    assert.equal(entry?.call.callId, "c1");
  });

  it("saves a run that paused for input and then completed after the user's choice", () => {
    const paused = fold([
      ...started,
      ev({ type: "needs_input", callId: "c1", tool: "qloo_resolve", message: "Which one?", issues: [] }),
      done("awaiting_input"),
    ]);
    assert.equal(paused.status, "awaiting_input");
    assert.equal(recentRunFrom(paused, request), null, "not while it waits");

    const resumed = fold(
      [
        { type: "submit", request: { sessionId: "s1", input: { kind: "resolution", choices: [] } } },
        ev({ type: "report", report: report() }),
        done("completed"),
      ],
      paused,
    );
    assert.equal(recentRunFrom(resumed, request)?.sessionId, "s1");
  });

  it("does not save runs that ended in error, were stopped, hit the step limit, or have no report", () => {
    const withReport = [...started, ev({ type: "report", report: report() })];
    assert.equal(recentRunFrom(fold([...withReport, done("error")]), request), null);
    assert.equal(recentRunFrom(fold([...withReport, done("max_steps")]), request), null);
    assert.equal(recentRunFrom(fold([...withReport, { type: "stopped" }]), request), null);
    assert.equal(recentRunFrom(fold([...started, done("completed")]), request), null);
    assert.equal(
      recentRunFrom(fold([...withReport, ev({ type: "error", code: "x", message: "boom", retryable: false }), done("completed")]), request),
      null,
    );
    assert.equal(recentRunFrom(fold([...withReport, { type: "failed", failure: { kind: "network", code: "network", message: "x", retryable: true } }]), request), null);
    assert.equal(recentRunFrom(fold(withReport), request), null, "still streaming");
  });

  it("saves a completed follow-up under the same session", () => {
    const first = fold([...started, ev({ type: "report", report: report(1) }), done("completed")]);
    const followUp = fold(
      [
        { type: "submit", request: { sessionId: "s1", input: { kind: "message", text: "More for teens" } } },
        ev({ type: "report", report: report(2) }),
        done("completed"),
      ],
      first,
    );
    const storage = fakeStorage();
    saveRecentRun(recentRunFrom(first, request, 1)!, storage);
    saveRecentRun(recentRunFrom(followUp, request, 2)!, storage);
    const runs = loadRecentRuns(storage);
    assert.equal(runs.length, 1);
    assert.equal(runs[0]?.report.version, 2);
    assert.deepEqual(runs[0]?.turns.map((t) => t.label), ["Your request", "More for teens"]);
  });
});

describe("relativeTime", () => {
  const now = Date.UTC(2026, 9, 6, 12, 0, 0);
  it("describes recent times in words", () => {
    assert.equal(relativeTime(now - 20_000, now), "just now");
    assert.equal(relativeTime(now + 60_000, now), "just now");
    assert.equal(relativeTime(now - 5 * 60_000, now), "5 min ago");
    assert.equal(relativeTime(now - 60 * 60_000, now), "1 hour ago");
    assert.equal(relativeTime(now - 3 * 60 * 60_000, now), "3 hours ago");
    assert.equal(relativeTime(now - 30 * 60 * 60_000, now), "yesterday");
    assert.equal(relativeTime(now - 4 * 24 * 60 * 60_000, now), "4 days ago");
    assert.match(relativeTime(now - 30 * 24 * 60 * 60_000, now), /2026/);
  });
});
