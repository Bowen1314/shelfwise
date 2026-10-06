import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { TestContext } from "node:test";
import { type UserTurn, runAgent } from "../src/agent/loop.js";
import { type ChatRequest, type LlmClient, LlmError } from "../src/agent/llm.js";
import { newSession } from "../src/agent/session.js";
import type { Report } from "../src/shared/types.js";
import {
  FORM,
  LIMITS,
  type FakeMcpOptions,
  type LlmStep,
  ScriptLlm,
  allStrings,
  calls,
  collect,
  ref,
  say,
  startFakeMcp,
  toolCall,
} from "./helpers/fakes.js";

/** The fake server's whole book list: nothing outside it may ever appear as a title in a report. */
const FAKE_BOOKS = ["Piranesi", "Station Eleven", "Klara and the Sun", "Kitchen Confidential", "Crying in H Mart", "The Memory Police"];
const FAKE_SIGNALS = ["Severance", "The Bear", "Phoebe Bridgers", "Nothingness", "Flaky", "Partialo", "Degradedo", "Slowpoke", "Crashy", "Ambiguo"];
const PLACE = "Newark, NJ";

interface Rig {
  mcp: ReturnType<typeof startFakeMcp>;
  session: ReturnType<typeof newSession>;
  ev: ReturnType<typeof collect>;
  run: (llm: LlmClient, turn?: UserTurn, opts?: { signal?: AbortSignal; limits?: Partial<typeof LIMITS> }) => ReturnType<typeof runAgent>;
}

function rig(t: TestContext, opts: FakeMcpOptions & { limits?: Partial<typeof LIMITS> } = {}): Rig {
  const mcp = startFakeMcp(opts);
  t.after(() => mcp.dispose());
  const session = newSession({ ...FORM }, "live");
  const ev = collect();
  const run: Rig["run"] = (llm, turn = { kind: "form" }, o = {}) =>
    runAgent({ llm, qloo: mcp.service, limits: { ...LIMITS, ...(opts.limits ?? {}), ...(o.limits ?? {}) }, sample: false, sleep: async () => {} }, session, turn, ev.emit, o.signal ?? new AbortController().signal);
  return { mcp, session, ev, run };
}

const plan = () => toolCall("set_plan", { steps: [{ title: "Find books for each thing patrons love", tool: "qloo_recommend" }, { title: "Rank the shortlist", tool: "qloo_rank" }] });
const rec = (signals: string[], extra: Record<string, unknown> = {}) => toolCall("qloo_recommend", { target_type: "book", signals, signal_location: PLACE, limit: 8, ...extra });

/** A complete, valid report built only from refs the model was shown. */
function goodSubmission(req: ChatRequest): Record<string, unknown> {
  const sev = ref(req, "Severance");
  const bear = ref(req, "The Bear");
  const pir = ref(req, "Piranesi");
  const se = ref(req, "Station Eleven");
  const hm = ref(req, "Crying in H Mart");
  return {
    bridge_shelf: [
      { loved_refs: [sev], book_ref: pir, why: `{${pir}} came back for fans of {${sev}}.` },
      { loved_refs: [bear], book_ref: hm, why: `{${hm}} came back for fans of {${bear}}.` },
    ],
    buy_list: [
      { book_ref: pir, rationale: `{${pir}} ranked first for this audience.` },
      { book_ref: se, rationale: `{${se}} also came back for readers of {${sev}}.` },
      { book_ref: hm, rationale: `{${hm}} came back for readers of {${bear}}.` },
    ],
    programmes: [{ kind: "film_night", title: "Watch and borrow", description: `Show a clip of {${sev}}, then offer {${pir}} at the desk.`, book_refs: [pir], signal_refs: [sev] }],
  };
}

const submit = (build: (req: ChatRequest) => Record<string, unknown> = goodSubmission): LlmStep => (req) => calls(toolCall("submit_report", build(req)));

/** The full workflow: per-signal recommends, then rank + where_popular + trends on a loved show, then the report. */
const happyScript = (): LlmStep[] => [
  () => calls(plan(), rec(["Severance"]), rec(["The Bear"])),
  (req) =>
    calls(
      toolCall("qloo_rank", { option_type: "book", options: [ref(req, "Piranesi"), ref(req, "Station Eleven"), ref(req, "Crying in H Mart")], signals: [ref(req, "Severance")], signal_location: PLACE }),
      toolCall("qloo_where_popular", { entity: ref(req, "Piranesi"), entity_type: "book", within: PLACE }),
      toolCall("qloo_trends", { entities: [ref(req, "Severance")], entity_type: "tv_show", start_date: "2026-01-01", end_date: "2026-09-30" }),
    ),
  submit(),
];

const toolNames = (req: ChatRequest): string[] => req.tools.map((t) => t.function.name);
const lastReport = (r: Rig): Report => {
  const e = r.ev.last("report");
  assert.ok(e, "expected a report event");
  return e.report;
};

describe("agent loop: the workflow", () => {
  it("runs plan, per-signal recommend, rank, local fit, trends, then publishes a report", async (t) => {
    const r = rig(t);
    const reason = await r.run(new ScriptLlm(happyScript()));

    assert.equal(reason, "completed");
    assert.equal(r.ev.last("done")?.reason, "completed");
    assert.equal(r.ev.of("plan").length, 1);

    // The evidence trail: every call is announced and answered, in order, with its inputs and status.
    const called = r.ev.of("tool_call").map((e) => e.call.tool);
    assert.deepEqual(called, ["qloo_recommend", "qloo_recommend", "qloo_rank", "qloo_where_popular", "qloo_trends"]);
    const results = r.ev.of("tool_result").map((e) => e.result);
    assert.equal(results.length, 5);
    assert.ok(results.every((x) => x.status === "ok"));
    assert.ok(results.every((x) => !x.sample), "live mode results are never marked as sample data");
    assert.deepEqual(r.mcp.realCalls().map((c) => c.tool), ["qloo_recommend", "qloo_recommend", "qloo_rank", "qloo_where_popular", "qloo_trends"]);

    const report = lastReport(r);
    assert.equal(report.sample, false);
    assert.equal(report.audience, "Whole community (no age focus)");
    assert.equal(report.bridgeShelf.length, 2);
    assert.equal(report.buyList.length, 3);
    assert.equal(report.programmes.length, 1);

    // Bridge cards are true by construction: each pairing cites a call that used that very signal.
    const card = report.bridgeShelf[0]!;
    assert.equal(card.loved[0]!.name, "Severance");
    assert.equal(card.book.name, "Piranesi");
    assert.ok(card.cites.some((c) => c.tool === "qloo_recommend"));
    assert.match(card.why, /^Piranesi came back for fans of Severance\.$/);

    // Scores, rank, local fit and trend are joined from tool results, not typed by the model.
    const top = report.buyList[0]!;
    assert.equal(top.book.name, "Piranesi");
    assert.ok(top.evidence.rank, "rank joined from qloo_rank");
    assert.ok(top.evidence.localFit, "local fit joined from qloo_where_popular");
    assert.equal(top.evidence.trend, undefined, "Qloo has no trend data for books");
    assert.deepEqual(
      top.evidence.signalTrends?.map((x) => [x.entity.name, x.direction]),
      [["Severance", "rising"]],
      "the matched signal's direction, computed by Shelfwise from the series",
    );
    assert.ok(top.cites.some((c) => c.tool === "qloo_trends"));
    assert.equal(report.buyList.find((b) => b.book.name === "Crying in H Mart")?.evidence.signalTrends, undefined, "The Bear was not trended");
    assert.deepEqual(top.evidence.matchedSignals.map((s) => s.name).sort(), ["Severance", "The Bear"]);
  });

  it("summarises live-shaped results: heatmap areas, series, and real entity types instead of urn:entity", async (t) => {
    const r = rig(t);
    await r.run(new ScriptLlm(happyScript()));
    const results = r.ev.of("tool_result").map((e) => e.result);
    const local = results.find((x) => x.tool === "qloo_where_popular")!;
    assert.equal(local.resultCount, 3);
    assert.match(local.summary, /^Qloo returned 3 areas within Newark, NJ; the strongest has affinity 0\.71\.$/);
    const trend = results.find((x) => x.tool === "qloo_trends")!;
    assert.match(trend.summary, /returned 1 series/);
    const recommend = results.find((x) => x.tool === "qloo_recommend")!;
    assert.ok(recommend.preview.length > 0);
    assert.ok(recommend.preview.every((p) => p.type === "book"), "subtype wins over the bare urn:entity type");
    assert.ok(!JSON.stringify(lastReport(r)).includes('"type":"urn:entity"'));
  });

  it("never lets a title the tools did not return reach the output", async (t) => {
    const r = rig(t);
    await r.run(new ScriptLlm(happyScript()));
    const report = lastReport(r);

    const haystack = r.ev.of("tool_result").map((e) => JSON.stringify(e.result.raw)).join("\n");
    const names = new Set<string>();
    for (const c of report.bridgeShelf) {
      names.add(c.book.name);
      c.loved.forEach((l) => names.add(l.name));
    }
    for (const b of report.buyList) names.add(b.book.name);
    assert.ok(names.size > 0);
    for (const n of names) {
      assert.ok(haystack.includes(n), `"${n}" is in the report but in no tool result`);
      assert.ok(FAKE_BOOKS.includes(n) || FAKE_SIGNALS.includes(n), `"${n}" is not in the fake dataset`);
    }
    // No placeholder survives into user-facing text.
    assert.ok(!allStrings(report).some((s) => /\{e\d+\}/.test(s)));
  });

  it("emits a visible evidence trail even for the plan and narration", async (t) => {
    const r = rig(t);
    const llm = new ScriptLlm([
      () => ({ content: "Checking what readers of each show also borrow.", toolCalls: [plan(), rec(["Severance"])] }),
      (req) => calls(toolCall("submit_report", { ...goodSubmissionFor(req), bridge_shelf: [] })),
    ]);
    await r.run(llm, { kind: "form" }, { limits: { maxReportRepairs: 0 } });
    assert.ok(r.ev.of("note").some((n) => /Checking what readers/.test(n.text)));
    assert.equal(r.ev.of("plan")[0]?.steps.length, 2);
  });
});

/** A submission that only uses Severance (the single signal queried). */
function goodSubmissionFor(req: ChatRequest): Record<string, unknown> {
  const sev = ref(req, "Severance");
  const pir = ref(req, "Piranesi");
  return {
    bridge_shelf: [{ loved_refs: [sev], book_ref: pir, why: `{${pir}} came back for fans of {${sev}}.` }],
    buy_list: [{ book_ref: pir, rationale: `{${pir}} came back for readers of {${sev}}.` }],
    programmes: [{ kind: "themed_display", title: "Shelf of the week", description: `Display {${pir}} beside a note about {${sev}}.`, book_refs: [pir], signal_refs: [sev] }],
  };
}

describe("agent loop: every Qloo status", () => {
  it("empty: tells the model, shows the empty result, and carries on", async (t) => {
    const r = rig(t);
    const llm = new ScriptLlm([
      () => calls(plan(), rec(["Nothingness"]), rec(["Severance"])),
      (req) => {
        const empty = req.messages.filter((m) => m.role === "tool").map((m) => (m.role === "tool" ? m.content : "")).find((c) => c.includes('"status":"empty"'));
        assert.ok(empty, "the model saw the empty status");
        assert.match(empty, /No results/);
        return submit(goodSubmissionFor)(req, 1);
      },
    ]);
    assert.equal(await r.run(llm), "completed");
    const statuses = r.ev.of("tool_result").map((e) => e.result.status);
    assert.deepEqual(statuses, ["empty", "ok"]);
    assert.equal(r.ev.of("tool_result")[0]!.result.resultCount, 0);
  });

  it("partial and degraded: results are used but every dependent item is flagged reduced", async (t) => {
    const r = rig(t);
    const llm = new ScriptLlm([
      () => calls(plan(), rec(["Partialo"]), rec(["Degradedo"])),
      (req) =>
        calls(
          toolCall("submit_report", {
            bridge_shelf: [
              { loved_refs: [ref(req, "Partialo")], book_ref: ref(req, "Kitchen Confidential"), why: `{${ref(req, "Kitchen Confidential")}} came back for fans of {${ref(req, "Partialo")}}.` },
              { loved_refs: [ref(req, "Degradedo")], book_ref: ref(req, "Crying in H Mart"), why: `{${ref(req, "Crying in H Mart")}} came back for fans of {${ref(req, "Degradedo")}}.` },
            ],
            buy_list: [{ book_ref: ref(req, "Kitchen Confidential"), rationale: `{${ref(req, "Kitchen Confidential")}} came back for {${ref(req, "Partialo")}} readers.` }],
            programmes: [{ kind: "other", title: "Pop-up table", description: `A table for fans of {${ref(req, "Partialo")}}.`, signal_refs: [ref(req, "Partialo")] }],
          }),
        ),
    ]);
    assert.equal(await r.run(llm), "completed");
    assert.deepEqual(r.ev.of("tool_result").map((e) => e.result.status), ["partial", "degraded"]);
    assert.ok(r.ev.of("tool_result").every((e) => e.result.warnings.length > 0), "warnings are surfaced in the trail");
    const report = lastReport(r);
    assert.ok(report.bridgeShelf.every((c) => c.reduced));
    assert.ok(report.buyList.every((b) => b.evidence.reduced));
    assert.ok(report.notes.some((n) => n.kind === "reduced"));
  });

  it("error, not retryable: one real call, no retry, the model is told the error", async (t) => {
    const r = rig(t);
    const llm = new ScriptLlm([
      () => calls(plan(), rec(["Brokenly"]), rec(["Severance"])),
      (req) => {
        const failed = req.messages.map((m) => (m.role === "tool" ? m.content : "")).find((c) => c.includes("QLOO_UPSTREAM_REQUEST"));
        assert.ok(failed, "the model saw the error code");
        assert.ok(failed.includes('"retryable":false'));
        return submit(goodSubmissionFor)(req, 1);
      },
    ]);
    assert.equal(await r.run(llm), "completed");
    assert.equal(r.ev.of("retry").length, 0);
    assert.equal(r.mcp.realCalls().filter((c) => JSON.stringify(c.args).includes("Brokenly")).length, 1);
    assert.equal(r.ev.of("tool_result")[0]!.result.status, "error");
    assert.equal(r.ev.of("tool_result")[0]!.result.error?.retryable, false);
  });

  it("error, retryable: retried (and only then), the failed attempt is not what the user sees", async (t) => {
    const r = rig(t);
    const llm = new ScriptLlm([() => calls(plan(), rec(["Flaky"])), (req) => calls(toolCall("submit_report", flakySubmission(req)))]);
    assert.equal(await r.run(llm), "completed");
    assert.equal(r.ev.of("retry").length, 1);
    assert.match(r.ev.of("retry")[0]!.reason, /QLOO_UPSTREAM_TIMEOUT/);
    assert.equal(r.mcp.realCalls().filter((c) => JSON.stringify(c.args).includes("Flaky")).length, 2);
    assert.equal(r.ev.of("tool_result").length, 1);
    assert.equal(r.ev.of("tool_result")[0]!.result.status, "ok");
  });

  it("error, retryable but retries are capped: gives up after the bound", async (t) => {
    const r = rig(t, { limits: { maxRetries: 0 } });
    const llm = new ScriptLlm([() => calls(plan(), rec(["Flaky"])), () => say("Qloo is timing out; try again shortly.")]);
    const reason = await r.run(llm);
    assert.equal(r.ev.of("retry").length, 0);
    assert.equal(r.mcp.realCalls().length, 1);
    assert.equal(r.ev.of("tool_result")[0]!.result.status, "error");
    assert.equal(r.ev.of("tool_result")[0]!.result.error?.retryable, true);
    assert.equal(reason, "completed");
    assert.ok(r.ev.of("message").some((m) => /timing out/.test(m.text)), "the model's explanation is shown");
    assert.equal(r.ev.of("report").length, 0, "no report is invented from a failed call");
  });

  it("error, authentication: stops the run immediately with a clear error and does not retry", async (t) => {
    const r = rig(t);
    const llm = new ScriptLlm([() => calls(plan(), rec(["Authfail"]), rec(["Severance"]))]);
    assert.equal(await r.run(llm), "error");
    assert.equal(llm.calls, 1, "no further model turns after a fatal Qloo failure");
    assert.equal(r.ev.of("error")[0]?.code, "QLOO_AUTH");
    assert.equal(r.ev.of("error")[0]?.retryable, false);
    assert.equal(r.ev.of("retry").length, 0);
    assert.equal(r.ev.last("done")?.reason, "error");
  });

  it("invalid arguments are rejected before Qloo is called", async (t) => {
    const r = rig(t);
    const llm = new ScriptLlm([
      () =>
        calls(
          plan(),
          toolCall("qloo_recommend", { target_type: "spaceship", signals: ["Severance"] }),
          toolCall("qloo_recommend", { target_type: "book", signals: ["Severance"], demographic: "teens" }),
          toolCall("qloo_recommend", { target_type: "book", signals: ["e99"], signal_location: PLACE }),
          toolCall("qloo_trends", { entities: ["Severance"], entity_type: "book", start_date: "2026-09-30", end_date: "2026-01-01" }),
        ),
      () => say("I could not run those."),
    ]);
    await r.run(llm);
    const results = r.ev.of("tool_result").map((e) => e.result);
    assert.equal(results.length, 4);
    assert.ok(results.every((x) => x.status === "error" && x.error?.code === "INVALID_ARGUMENTS"));
    assert.equal(r.mcp.realCalls().length, 0, "nothing reached Qloo");
    assert.match(results[2]!.summary, /Unknown ref/);
    assert.match(results[1]!.summary, /signal_location/);
  });
});

describe("agent loop: arguments the live API would reject", () => {
  it("book trends are refused before Qloo with a message that says what to do instead", async (t) => {
    const r = rig(t);
    const llm = new ScriptLlm([
      () => calls(plan(), rec(["Severance"])),
      (req) => calls(toolCall("qloo_trends", { entities: [ref(req, "Piranesi")], entity_type: "book", start_date: "2026-01-01", end_date: "2026-09-30" })),
      (req) => {
        const text = req.messages.at(-1)?.content ?? "";
        assert.match(String(text), /no trend data/);
        assert.match(String(text), /tv_show/);
        return calls(toolCall("qloo_trends", { entities: [ref(req, "Severance")], entity_type: "tv_show", start_date: "2026-01-01", end_date: "2026-09-30" }));
      },
      () => say("Done."),
    ]);
    await r.run(llm);
    const trends = r.ev.of("tool_result").map((e) => e.result).filter((x) => x.tool === "qloo_trends");
    assert.equal(trends.length, 2);
    assert.equal(trends[0]!.error?.code, "INVALID_ARGUMENTS");
    assert.equal(trends[1]!.status, "ok");
    const real = r.mcp.realCalls().filter((c) => c.tool === "qloo_trends");
    assert.equal(real.length, 1, "only the supported call reached Qloo");
    assert.equal(real[0]!.args["entity_type"], "tv_show");
  });

  it("the fake upstream really rejects book trends (so the guard above is what keeps them off the screen)", async (t) => {
    const r = rig(t);
    const res = await r.mcp.service.call("qloo_trends", { entities: ["Piranesi"], entity_type: "book", start_date: "2026-01-01", end_date: "2026-09-30" });
    assert.equal(res.envelope.status, "error");
    assert.match(String(res.envelope.summary), /400/);
  });

  it("drops a limit passed to qloo_rank (which takes none) and tells the model, instead of failing the call", async (t) => {
    const r = rig(t);
    const llm = new ScriptLlm([
      () => calls(plan(), rec(["Severance"])),
      (req) => calls(toolCall("qloo_rank", { option_type: "book", options: [ref(req, "Piranesi"), ref(req, "Station Eleven")], signals: [ref(req, "Severance")], signal_location: PLACE, limit: 5 })),
      (req) => {
        const text = String(req.messages.at(-1)?.content ?? "");
        assert.match(text, /Ignored argument \\"limit\\": qloo_rank does not take it/);
        assert.match(text, /"status":"ok"/);
        return say("Done.");
      },
    ]);
    await r.run(llm);
    const rank = r.ev.of("tool_result").map((e) => e.result).find((x) => x.tool === "qloo_rank")!;
    assert.equal(rank.status, "ok");
    const sent = r.mcp.realCalls().find((c) => c.tool === "qloo_rank")!;
    assert.equal("limit" in sent.args, false);
    assert.equal("limit" in (r.ev.of("tool_call").map((e) => e.call).find((c) => c.tool === "qloo_rank")?.args ?? {}), false);
  });

  it("still rejects other unknown arguments", async (t) => {
    const r = rig(t);
    const llm = new ScriptLlm([
      () => calls(plan(), toolCall("qloo_rank", { option_type: "book", options: ["Piranesi"], signals: ["Severance"], sort: "desc" })),
      () => say("Done."),
    ]);
    await r.run(llm);
    const rank = r.ev.of("tool_result").map((e) => e.result).find((x) => x.tool === "qloo_rank")!;
    assert.equal(rank.error?.code, "INVALID_ARGUMENTS");
    assert.match(rank.summary, /unknown argument "sort"/);
    assert.equal(r.mcp.realCalls().length, 0);
  });
});

function flakySubmission(req: ChatRequest): Record<string, unknown> {
  const f = ref(req, "Flaky");
  const pir = ref(req, "Piranesi");
  return {
    bridge_shelf: [{ loved_refs: [f], book_ref: pir, why: `{${pir}} came back for fans of {${f}}.` }],
    buy_list: [{ book_ref: pir, rationale: `{${pir}} came back for {${f}} readers.` }],
    programmes: [{ kind: "book_club", title: "Read together", description: `A club for fans of {${f}} reading {${pir}}.`, book_refs: [pir], signal_refs: [f] }],
  };
}

describe("agent loop: needs_input pause and resume", () => {
  it("pauses on an ambiguous entity, asks, and resumes with the chosen id", async (t) => {
    const r = rig(t);
    const first = new ScriptLlm([() => calls(plan(), rec(["Ambiguo"]), rec(["Severance"]))]);
    const reason = await r.run(first);

    assert.equal(reason, "awaiting_input");
    assert.equal(first.calls, 1, "the model is not asked to guess after a needs_input");
    assert.equal(r.ev.last("done")?.reason, "awaiting_input");
    const ask = r.ev.of("needs_input");
    assert.equal(ask.length, 1);
    const issue = ask[0]!.issues[0]!;
    assert.equal(issue.input, "Ambiguo");
    assert.equal(issue.kind, "ambiguous");
    assert.deepEqual(issue.candidates.map((c) => c.id), ["amb-book", "amb-film"]);
    assert.equal(r.session.pending.size, 1, "the open question is kept server-side");
    // The other call in the same turn still ran and is shown.
    assert.deepEqual(r.ev.of("tool_result").map((e) => e.result.status).sort(), ["needs_input", "ok"]);

    // Resume with the user's pick.
    const second = new ScriptLlm([
      (req) => {
        const last = req.messages.at(-1);
        assert.equal(last?.role, "user");
        assert.match(last?.role === "user" ? last.content : "", /confirmed Ambiguo \[book\].*amb-book/s);
        return calls(rec(["amb-book"]));
      },
      (req) =>
        calls(
          toolCall("submit_report", {
            bridge_shelf: [{ loved_refs: [ref(req, "Ambiguo")], book_ref: ref(req, "Station Eleven"), why: `{${ref(req, "Station Eleven")}} came back for fans of {${ref(req, "Ambiguo")}}.` }],
            buy_list: [{ book_ref: ref(req, "Station Eleven"), rationale: `{${ref(req, "Station Eleven")}} came back for {${ref(req, "Ambiguo")}} readers.` }],
            programmes: [{ kind: "themed_display", title: "If you liked it", description: `Display {${ref(req, "Station Eleven")}} for fans of {${ref(req, "Ambiguo")}}.`, book_refs: [ref(req, "Station Eleven")], signal_refs: [ref(req, "Ambiguo")] }],
          }),
        ),
    ]);
    const before = r.mcp.realCalls().length;
    const resumed = await r.run(second, { kind: "resolution", choices: [{ issueId: issue.issueId, pick: issue.candidates[0]! }] });
    assert.equal(resumed, "completed");
    assert.equal(r.session.pending.size, 0);
    const after = r.mcp.realCalls().slice(before);
    assert.equal(after.length, 1);
    assert.deepEqual(after[0]!.args["signals"], ["amb-book"], "the confirmed id was sent, not the ambiguous name again");
    const resumedLabel = r.ev.of("tool_call").at(-1)?.call.label ?? "";
    assert.match(resumedLabel, /Ambiguo/, "the evidence trail names the confirmed entity");
    assert.ok(!resumedLabel.includes("amb-book"), "the raw Qloo id is not shown to the user");
    assert.equal(lastReport(r).bridgeShelf[0]?.loved[0]?.name, "Ambiguo");
  });

  it("a skipped question is not used", async (t) => {
    const r = rig(t);
    await r.run(new ScriptLlm([() => calls(plan(), rec(["Ambiguo"]))]));
    const issue = r.ev.of("needs_input")[0]!.issues[0]!;
    const second = new ScriptLlm([
      (req) => {
        const last = req.messages.at(-1);
        assert.match(last?.role === "user" ? last.content : "", /chose to skip it/);
        return say("Understood, I will leave that one out.");
      },
    ]);
    assert.equal(await r.run(second, { kind: "resolution", choices: [{ issueId: issue.issueId, pick: null }] }), "completed");
    assert.equal(r.mcp.realCalls().length, 1, "no further Qloo call was made for the skipped item");
  });

  it("a name Qloo cannot find asks the user too (not_found)", async (t) => {
    const r = rig(t);
    const reason = await r.run(new ScriptLlm([() => calls(plan(), rec(["Notfoundo"]))]));
    assert.equal(reason, "awaiting_input");
    assert.equal(r.ev.of("needs_input")[0]!.issues[0]!.kind, "not_found");
  });
});

describe("agent loop: bounds", () => {
  it("forces submit_report as the only tool when the step budget is about to run out", async (t) => {
    const r = rig(t, { limits: { maxSteps: 3 } });
    const seen: ChatRequest[] = [];
    const llm = new ScriptLlm([
      () => calls(plan(), rec(["Severance"])),
      () => calls(rec(["The Bear"])),
      (req) => {
        seen.push(req);
        return calls(toolCall("submit_report", goodSubmission(req)));
      },
    ]);
    assert.equal(await r.run(llm), "completed");
    assert.deepEqual(toolNames(seen[0]!), ["submit_report"]);
    assert.deepEqual(seen[0]!.toolChoice, { type: "function", function: { name: "submit_report" } });
    assert.equal(llm.requests[0]!.tools.length > 3, true, "earlier turns had the full tool set");
  });

  it("stops with max_steps and says so when the model never reports", async (t) => {
    const r = rig(t, { limits: { maxSteps: 3 } });
    const llm = new ScriptLlm([], () => calls(rec(["Severance"])));
    assert.equal(await r.run(llm), "max_steps");
    assert.equal(llm.calls, 3);
    assert.equal(r.ev.of("error").at(-1)?.code, "MAX_STEPS");
    assert.equal(r.ev.of("report").length, 0);
  });

  it("caps tool calls per request and refuses the rest", async (t) => {
    const r = rig(t, { limits: { maxToolCalls: 2 } });
    const llm = new ScriptLlm([
      () => calls(plan(), rec(["Severance"]), rec(["The Bear"]), rec(["Phoebe Bridgers"]), rec(["Partialo"])),
      (req) => {
        const refused = req.messages.filter((m) => m.role === "tool" && m.content.includes("TOOL_BUDGET_EXHAUSTED"));
        assert.equal(refused.length, 2);
        return say("Out of budget.");
      },
    ]);
    await r.run(llm);
    assert.equal(r.mcp.realCalls().length, 2);
    assert.equal(r.ev.last("done")?.toolCalls, 2);
  });

  it("refuses submit_report in the same turn as Qloo calls", async (t) => {
    const r = rig(t);
    const llm = new ScriptLlm([
      () => calls(plan(), rec(["Severance"]), toolCall("submit_report", { bridge_shelf: [], buy_list: [], programmes: [] })),
      (req) => {
        assert.ok(req.messages.some((m) => m.role === "tool" && m.content.includes("own turn")));
        return calls(toolCall("submit_report", goodSubmissionFor(req)));
      },
    ]);
    assert.equal(await r.run(llm), "completed");
    assert.equal(r.ev.of("report").length, 1);
  });

  it("stops promptly when the client goes away", async (t) => {
    const r = rig(t);
    const ac = new AbortController();
    const llm = new ScriptLlm([
      () => {
        ac.abort();
        return calls(plan(), rec(["Severance"]));
      },
    ]);
    assert.equal(await r.run(llm, { kind: "form" }, { signal: ac.signal }), "aborted");
    assert.equal(r.ev.last("done")?.reason, "aborted");
  });

  it("retries a transient model error, then continues", async (t) => {
    const r = rig(t);
    const llm = new ScriptLlm([
      () => {
        throw new LlmError("overloaded", true, 503);
      },
      ...happyScript(),
    ]);
    assert.equal(await r.run(llm), "completed");
    assert.ok(r.ev.of("note").some((n) => /busy; retrying/.test(n.text)));
  });

  it("reports a permanent model error plainly and ends", async (t) => {
    const r = rig(t);
    const llm = new ScriptLlm([
      () => {
        throw new LlmError("invalid api key", false, 401);
      },
    ]);
    assert.equal(await r.run(llm), "error");
    assert.equal(r.ev.of("error")[0]?.code, "LLM_ERROR");
    assert.equal(r.ev.of("error")[0]?.retryable, false);
  });
});

describe("no-invention guard", () => {
  const sneaky = (req: ChatRequest): Record<string, unknown> => {
    const sev = ref(req, "Severance");
    const pir = ref(req, "Piranesi");
    const hm = ref(req, "Crying in H Mart");
    const se = ref(req, "Station Eleven");
    return {
      bridge_shelf: [
        { loved_refs: [sev], book_ref: pir, why: `{${pir}} came back for fans of {${sev}}.` }, // valid
        { loved_refs: [sev], book_ref: hm, why: `{${hm}} came back for fans of {${sev}}.` }, // H Mart was never returned for Severance
        { loved_refs: [sev], book_ref: "e99", why: "A book Qloo never returned." }, // unknown ref
        { loved_refs: [pir], book_ref: se, why: "A book as a signal?" }, // a result used as a loved signal
      ],
      buy_list: [
        { book_ref: pir, rationale: `{${pir}} came back for readers of {${sev}}.` }, // valid
        { book_ref: se, rationale: 'Readers adore "The Invented Novel" by a famous author.' }, // invented title
        { book_ref: hm, rationale: `{${hm}} is loved by 87 patrons in this area.` }, // invented number
        { book_ref: "e98", rationale: "No such ref." },
      ],
      programmes: [{ kind: "film_night", title: "Watch and borrow", description: `Show {${sev}}, offer {${pir}}.`, book_refs: [pir], signal_refs: [sev] }],
    };
  };

  const prime: LlmStep[] = [() => calls(plan(), rec(["Severance"]), rec(["The Bear"]))];

  it("rejects invented titles, invented numbers, unknown refs and unsupported pairings, with reasons the model can act on", async (t) => {
    const r = rig(t);
    let feedback = "";
    const llm = new ScriptLlm([
      ...prime,
      (req) => calls(toolCall("submit_report", sneaky(req))),
      (req) => {
        feedback = req.messages.findLast((m) => m.role === "tool")?.content ?? "";
        return calls(toolCall("submit_report", goodSubmission(req)));
      },
    ]);
    assert.equal(await r.run(llm), "completed");

    const parsed = JSON.parse(feedback) as { ok: boolean; problems: string[] };
    assert.equal(parsed.ok, false);
    const text = parsed.problems.join("\n");
    assert.match(text, /e99 is not a ref/);
    assert.match(text, /no Qloo result links/);
    assert.match(text, /The Invented Novel.*not a title/);
    assert.match(text, /number 87 does not appear/);
    assert.match(text, /e98 is not a ref/);
    assert.match(text, /only ever a result/);

    // Nothing from the rejected attempt reached the user: exactly one report, built from the repaired submission.
    assert.equal(r.ev.of("report").length, 1);
    const report = lastReport(r);
    const everything = allStrings(report).join("\n");
    assert.ok(!everything.includes("Invented Novel"));
    assert.ok(!everything.includes("87"));
    assert.equal(report.bridgeShelf.length, 2);
  });

  it("on the last repair attempt publishes only the items that trace to Qloo and says what was withheld", async (t) => {
    const r = rig(t, { limits: { maxReportRepairs: 0 } });
    const llm = new ScriptLlm([...prime, (req) => calls(toolCall("submit_report", sneaky(req)))]);
    assert.equal(await r.run(llm), "completed");
    const report = lastReport(r);
    assert.deepEqual(report.bridgeShelf.map((c) => c.book.name), ["Piranesi"]);
    assert.deepEqual(report.buyList.map((b) => b.book.name), ["Piranesi"]);
    assert.ok(report.notes.some((n) => n.kind === "guard" && /withheld/.test(n.text)));
    assert.ok(!allStrings(report).join("\n").includes("Invented Novel"));
  });

  it("accepts the user's own words in quotes, but not other names", async (t) => {
    const r = rig(t);
    const llm = new ScriptLlm([
      ...prime,
      (req) => {
        const sub = goodSubmission(req) as { programmes: { description: string }[] };
        sub.programmes[0]!.description = 'Pair a clip of "Severance" with a table of "Gone Girl" copies.';
        return calls(toolCall("submit_report", sub));
      },
      (req) => {
        const fb = JSON.parse(req.messages.findLast((m) => m.role === "tool")?.content ?? "{}") as { problems?: string[] };
        const joined = (fb.problems ?? []).join("\n");
        assert.match(joined, /"Gone Girl"/);
        assert.ok(!/"Severance"/.test(joined), "Severance was typed by the user, so quoting it is fine");
        return calls(toolCall("submit_report", goodSubmission(req)));
      },
    ]);
    assert.equal(await r.run(llm), "completed");
  });

  it("a report written as plain JSON text is parsed and held to the same rules", async (t) => {
    const r = rig(t);
    const llm = new ScriptLlm([
      ...prime,
      (req) => say(`Here is the report:\n\`\`\`json\n${JSON.stringify(sneaky(req))}\n\`\`\``),
      (req) => say(JSON.stringify(goodSubmission(req))),
    ]);
    assert.equal(await r.run(llm), "completed");
    const report = lastReport(r);
    assert.ok(!allStrings(report).join("\n").includes("Invented Novel"));
    assert.equal(report.bridgeShelf.length, 2);
  });

  it("a model that only chats after getting results is nudged once, then the run fails honestly (no made-up report)", async (t) => {
    const r = rig(t);
    const llm = new ScriptLlm([...prime, () => say("I think readers will love Dune."), () => say("Really, Dune.")]);
    assert.equal(await r.run(llm), "error");
    assert.equal(r.ev.of("report").length, 0);
    assert.equal(r.ev.of("error").at(-1)?.code, "NO_REPORT");
    assert.ok(llm.requests[1]!.messages.some((m) => m.role === "user" && /call submit_report/.test(m.content)), "the model was nudged");
  });

  it("a bridge card cannot pair a signal with a book returned only for a different signal", async (t) => {
    const r = rig(t, { limits: { maxReportRepairs: 0 } });
    const llm = new ScriptLlm([
      ...prime,
      (req) => {
        const bear = ref(req, "The Bear");
        const sev = ref(req, "Severance");
        const klara = ref(req, "Klara and the Sun"); // returned for Severance (and Phoebe), never for The Bear
        const pir = ref(req, "Piranesi");
        return calls(
          toolCall("submit_report", {
            bridge_shelf: [{ loved_refs: [bear], book_ref: klara, why: `{${klara}} came back for fans of {${bear}}.` }],
            buy_list: [{ book_ref: pir, rationale: `{${pir}} came back for readers of {${sev}}.` }],
            programmes: [{ kind: "other", title: "Table", description: `For fans of {${sev}}.`, signal_refs: [sev] }],
          }),
        );
      },
    ]);
    await r.run(llm);
    const report = lastReport(r);
    assert.equal(report.bridgeShelf.length, 0, "the unsupported pairing is withheld");
    assert.equal(report.buyList.length, 1);
  });
});

describe("follow-ups re-run the relevant tools", () => {
  it("'make it for teens' re-queries Qloo with the audience, bumps the version, and relabels the audience", async (t) => {
    const r = rig(t);
    await r.run(new ScriptLlm(happyScript()));
    assert.equal(lastReport(r).version, 1);
    const before = r.mcp.realCalls().length;

    const followUp = new ScriptLlm([
      (req) => {
        const last = req.messages.at(-1);
        assert.equal(last?.role === "user" ? last.content : "", "make it for teens");
        return calls(rec(["Severance"], { demographic: "teens" }), rec(["The Bear"], { demographic: "teens" }));
      },
      (req) => submit()(req, 1),
    ]);
    assert.equal(await r.run(followUp, { kind: "message", text: "make it for teens" }), "completed");

    const newCalls = r.mcp.realCalls().slice(before);
    assert.equal(newCalls.length, 2);
    assert.ok(newCalls.every((c) => c.args["demographic"] === "teens"), "the audience reached Qloo");
    const report = lastReport(r);
    assert.equal(report.version, 2);
    assert.equal(report.audience, "Teens and young adults");
    assert.ok(report.notes.some((n) => n.kind === "gap" && /24 and younger/.test(n.text)), "the coarse age band limitation is stated");
    assert.equal(r.session.followUps, 1);
  });

  it("a question that needs no tools is answered in chat and the report is left alone", async (t) => {
    const r = rig(t);
    await r.run(new ScriptLlm(happyScript()));
    const reportsBefore = r.ev.of("report").length;
    const calls0 = r.mcp.realCalls().length;
    const chat = new ScriptLlm([() => say("Affinity is a relative score from Qloo's taste graph, not a count of patrons.")]);
    assert.equal(await r.run(chat, { kind: "message", text: "what does affinity mean?" }), "completed");
    assert.equal(r.ev.of("report").length, reportsBefore);
    assert.equal(r.mcp.realCalls().length, calls0);
    assert.match(r.ev.of("message").at(-1)!.text, /Affinity is a relative score/);
  });

  it("a repeated identical call in a follow-up is served from the cache (no extra Qloo call)", async (t) => {
    const r = rig(t);
    await r.run(new ScriptLlm(happyScript()));
    const before = r.mcp.realCalls().length;
    const llm = new ScriptLlm([
      () => calls(rec(["severance"])), // same call, different case
      () => say("Same results as before."),
    ]);
    await r.run(llm, { kind: "message", text: "check Severance again" });
    assert.equal(r.mcp.realCalls().length, before);
    assert.equal(r.ev.of("tool_result").at(-1)!.result.cached, true);
  });
});
