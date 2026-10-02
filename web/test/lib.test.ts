import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { Report } from "@shared/types";
import { buyListToCsv, buyListToText } from "../src/lib/exportReport";
import { sampleBannerDetail, sampleBannerPlanner } from "../src/lib/banner";
import { httpFailure, minutesPhrase } from "../src/lib/failure";
import { budgetMath, containsContactDetails, EMPTY_FORM, validateForm } from "../src/lib/validate";

describe("containsContactDetails", () => {
  it("flags emails and phone-like numbers", () => {
    assert.equal(containsContactDetails("write to jo@example.org"), true);
    assert.equal(containsContactDetails("call 555-123-4567"), true);
    assert.equal(containsContactDetails("call (973) 555 0134"), true);
    assert.equal(containsContactDetails("+1 973 555 0134"), true);
    assert.equal(containsContactDetails("5551234567"), true);
  });

  it("leaves ordinary interests alone, including years and short numbers", () => {
    assert.equal(containsContactDetails("Severance, Fleabag, the 2022 and 2023 seasons"), false);
    assert.equal(containsContactDetails("2022 2023 2024"), false);
    assert.equal(containsContactDetails("Fahrenheit 451, Catch-22, 1984"), false);
    assert.equal(containsContactDetails("Ages 12-14, grade 7"), false);
  });
});

describe("validateForm", () => {
  const valid = { ...EMPTY_FORM, place: " Newark, NJ ", interests: "Severance, Fleabag", titleCount: "8" };

  it("accepts a good form and trims it", () => {
    const { errors, input } = validateForm(valid);
    assert.deepEqual(errors, {});
    assert.deepEqual(input, { place: "Newark, NJ", ageBand: "any", interests: "Severance, Fleabag", titleCount: 8 });
  });

  it("reports each problem on its own field", () => {
    const { errors, input } = validateForm({ ...EMPTY_FORM, titleCount: "2" });
    assert.equal(input, null);
    assert.ok(errors.place);
    assert.ok(errors.interests);
    assert.ok(errors.titleCount);
  });

  it("rejects contact details and over-long text", () => {
    assert.ok(validateForm({ ...valid, interests: "me at a@b.co" }).errors.interests);
    assert.ok(validateForm({ ...valid, interests: "x".repeat(601) }).errors.interests);
  });

  it("rejects non-integer and out-of-range counts", () => {
    assert.ok(validateForm({ ...valid, titleCount: "2.5" }).errors.titleCount);
    assert.ok(validateForm({ ...valid, titleCount: "21" }).errors.titleCount);
    assert.equal(validateForm({ ...valid, titleCount: "20" }).errors.titleCount, undefined);
  });

  it("includes budget and price only when both are valid", () => {
    assert.deepEqual(validateForm({ ...valid, budget: "400", avgPrice: "18" }).input?.budget, 400);
    assert.equal(validateForm({ ...valid, budget: "400" }).input?.budget, undefined);
    assert.equal(validateForm({ ...valid, budget: "400", avgPrice: "0" }).input?.avgPrice, undefined);
  });
});

describe("budgetMath", () => {
  it("rounds down and clamps to the allowed range", () => {
    const math = budgetMath("400", "18");
    assert.equal(math?.titles, 22);
    assert.equal(math?.clamped, 20);
    assert.equal(math?.exact, false);
    assert.equal(budgetMath("10", "5")?.clamped, 3);
    assert.equal(budgetMath("90", "10")?.exact, true);
  });

  it("is null until both numbers are usable", () => {
    assert.equal(budgetMath("", "18"), null);
    assert.equal(budgetMath("400", "abc"), null);
    assert.equal(budgetMath("400", "0"), null);
  });
});

describe("failure messages", () => {
  it("words the rate limit in minutes", () => {
    assert.equal(minutesPhrase(540), "9 minutes");
    assert.equal(minutesPhrase(61), "2 minutes");
    assert.equal(minutesPhrase(30), "a minute");
    assert.match(httpFailure(429, "rate_limited", "", 540).message, /try again in 9 minutes/);
  });

  it("does not offer retry for an expired session or a rejected request", () => {
    assert.equal(httpFailure(404, "no_session", "").retryable, false);
    assert.equal(httpFailure(400, "bad_request", "place is required").retryable, false);
    assert.equal(httpFailure(503, "busy", "").retryable, true);
  });
});

const report: Report = {
  version: 3,
  createdAt: "",
  sample: false,
  place: "Newark, NJ",
  audience: "Whole community",
  bridgeShelf: [],
  programmes: [],
  notes: [],
  budgetNote: "$400 / $18 per title = 22 titles",
  buyList: [
    {
      rank: 1,
      book: { handle: "b1", entityId: "x", name: "Piranesi, a novel", year: 2020 },
      rationale: 'She said "go"; it\'s short.',
      cites: [],
      evidence: { matchedSignals: [{ handle: "e1", entityId: "y", name: "Severance" }, { handle: "e2", entityId: "z", name: "Fleabag" }], recommendations: [], reduced: false },
    },
    {
      rank: 2,
      book: { handle: "b2", entityId: "q", name: "=SUM(A1)" },
      rationale: "-starts with a dash",
      cites: [],
      evidence: { matchedSignals: [], recommendations: [], reduced: false },
    },
  ],
};

describe("export", () => {
  it("writes CSV with the required columns, quoting and formula protection", () => {
    const lines = buyListToCsv(report).trimEnd().split("\r\n");
    assert.equal(lines[0], "rank,title,year,rationale,matched_signals");
    assert.equal(lines[1], '1,"Piranesi, a novel",2020,"She said ""go""; it\'s short.",Severance; Fleabag');
    assert.equal(lines[2], "2,'=SUM(A1),,'-starts with a dash,");
  });

  it("writes plain text with the title, year and rationale", () => {
    const text = buyListToText(report);
    assert.match(text, /1\. Piranesi, a novel \(2020\)\n {3}She said/);
    assert.match(text, /\$400 \/ \$18 per title = 22 titles/);
  });
});

describe("sampleBannerDetail", () => {
  it("scripted planner (or health not loaded yet): placeholders, nothing about a model", () => {
    for (const llm of [{ provider: "scripted-demo", model: "scripted-demo-planner (placeholder, not a language model)", scripted: true }, undefined]) {
      const text = sampleBannerDetail(llm);
      assert.match(text, /built-in placeholders/);
      assert.doesNotMatch(text, /real language model/);
    }
  });

  it("the short narrow-screen note appears only for a real model", () => {
    assert.equal(sampleBannerPlanner({ provider: "scripted-demo", model: "m", scripted: true }), null);
    assert.equal(sampleBannerPlanner(undefined), null);
    assert.match(sampleBannerPlanner({ provider: "openai-compatible", model: "m", scripted: false }) ?? "", /Real language model, sample data/);
  });

  it("real model on sample data: says so, names the model", () => {
    const text = sampleBannerDetail({ provider: "openai-compatible", model: "nvidia/nemotron-3-super-120b-a12b", scripted: false });
    assert.match(text, /built-in placeholders/);
    assert.match(text, /real language model \(nvidia\/nemotron-3-super-120b-a12b\)/);
    assert.match(text, /sample data/);
  });
});
