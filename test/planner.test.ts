import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { ScriptedDemoLlm } from "../src/agent/demo-llm.js";
import { OpenAiCompatLlm } from "../src/agent/llm.js";
import { DEFAULT_LLM_BASE_URL, DEFAULT_LLM_MODEL, loadConfig } from "../src/server/config.js";
import { baseUrlHost, createLlm, describeLlm, startupLines } from "../src/server/planner.js";

const KEY = "dummy-key-never-to-be-printed";

describe("createLlm: which planner runs", () => {
  it("sample mode, no NEBIUS_API_KEY: the scripted placeholder", () => {
    const llm = createLlm(loadConfig({ DEMO_FIXTURES: "1" }), true);
    assert.ok(llm instanceof ScriptedDemoLlm);
    assert.equal(llm.scripted, true);
  });

  it("sample mode with NEBIUS_API_KEY: the real client (sample Qloo data, real model), only then", () => {
    const llm = createLlm(loadConfig({ DEMO_FIXTURES: "1", NEBIUS_API_KEY: KEY }), true);
    assert.ok(llm instanceof OpenAiCompatLlm);
    assert.equal(llm.scripted, false);
    assert.equal(llm.model, DEFAULT_LLM_MODEL);
  });

  it("generic variables from other tools never select the real client", () => {
    const env = { DEMO_FIXTURES: "1", LLM_API_KEY: KEY, OPENAI_API_KEY: KEY, LLM_BASE_URL: "http://127.0.0.1:9", LLM_MODEL: "x" };
    assert.equal(createLlm(loadConfig(env), true).scripted, true);
  });

  it("live mode without a key: an inert client (runs are refused before it is ever used)", () => {
    const llm = createLlm(loadConfig({}), false);
    assert.ok(llm instanceof OpenAiCompatLlm);
    assert.equal(llm.scripted, false);
  });
});

describe("describeLlm: one source of truth for /api/health and the startup log", () => {
  it("reports the scripted planner as scripted", () => {
    const config = loadConfig({ DEMO_FIXTURES: "1" });
    const d = describeLlm(createLlm(config, true), config);
    assert.equal(d.scripted, true);
    assert.equal(d.provider, "scripted-demo");
  });

  it("reports the real client as NOT scripted even though it carries a `scripted` property", () => {
    // The original defect: the log used `"scripted" in llm`, which is true for every client because the property exists.
    const config = loadConfig({ DEMO_FIXTURES: "1", NEBIUS_API_KEY: KEY });
    const llm = createLlm(config, true);
    assert.ok("scripted" in llm, "the property exists on both clients, so `in` cannot tell them apart");
    assert.equal(describeLlm(llm, config).scripted, false);
  });
});

describe("baseUrlHost", () => {
  it("returns only host[:port]: no scheme, path, query or credentials", () => {
    assert.equal(baseUrlHost(DEFAULT_LLM_BASE_URL), "api.tokenfactory.nebius.com");
    assert.equal(baseUrlHost("http://127.0.0.1:9/v1/"), "127.0.0.1:9");
    assert.equal(baseUrlHost("https://user:secret@example.test/v1/?token=abc"), "example.test");
  });

  it("does not throw on junk", () => {
    assert.equal(baseUrlHost("not a url"), "(invalid base URL)");
    assert.equal(baseUrlHost(""), "(invalid base URL)");
  });
});

describe("startupLines", () => {
  const lines = (env: Record<string, string>, sample: boolean): string => {
    const config = loadConfig(env);
    return startupLines(config, sample, createLlm(config, sample)).join("\n");
  };

  it("sample mode, no key: says the planner is the scripted placeholder and how to change that", () => {
    const out = lines({ DEMO_FIXTURES: "1" }, true);
    assert.match(out, /SAMPLE DATA/);
    assert.match(out, /Planner: scripted placeholder/);
    assert.match(out, /NEBIUS_API_KEY/);
    assert.doesNotMatch(out, /nebius\.com/, "no model host is named when no model will be called");
  });

  it("sample mode with a key: says REAL model, names the host, and that the Qloo data is still sample", () => {
    const out = lines({ DEMO_FIXTURES: "1", NEBIUS_API_KEY: KEY }, true);
    assert.match(out, /SAMPLE DATA/);
    assert.match(out, /Planner: REAL language model nvidia\/nemotron-3-super-120b-a12b via api\.tokenfactory\.nebius\.com/);
    assert.match(out, /SAMPLE Qloo data/);
    assert.doesNotMatch(out, /scripted placeholder/);
  });

  it("uses the configured base URL host, not the path", () => {
    const out = lines({ DEMO_FIXTURES: "1", NEBIUS_API_KEY: KEY, SHELFWISE_LLM_BASE_URL: "http://127.0.0.1:9/v1/", SHELFWISE_LLM_MODEL: "m" }, true);
    assert.match(out, /REAL language model m via 127\.0\.0\.1:9 /);
    assert.doesNotMatch(out, /\/v1/);
  });

  it("generic foreign variables do not turn the log line into a model line", () => {
    const out = lines({ DEMO_FIXTURES: "1", LLM_API_KEY: KEY, LLM_BASE_URL: "http://127.0.0.1:9", LLM_MODEL: "x" }, true);
    assert.match(out, /Planner: scripted placeholder/);
    assert.doesNotMatch(out, /127\.0\.0\.1|REAL/);
  });

  it("live mode: model and host; says when the key is missing", () => {
    assert.match(lines({ QLOO_API_KEY: "q", NEBIUS_API_KEY: KEY }, false), /^Mode: live\. Model: nvidia\/nemotron-3-super-120b-a12b via api\.tokenfactory\.nebius\.com$/);
    assert.match(lines({ QLOO_API_KEY: "q" }, false), /NEBIUS_API_KEY is not set: runs are refused/);
  });

  it("never contains any part of any key", () => {
    for (const sample of [true, false]) {
      const out = lines({ DEMO_FIXTURES: sample ? "1" : "", QLOO_API_KEY: "qloo-secret-value", NEBIUS_API_KEY: KEY, LLM_API_KEY: "foreign-secret-value" }, sample);
      for (const secret of [KEY, "dummy-key", "qloo-secret-value", "foreign-secret-value"]) assert.ok(!out.includes(secret), `${secret} leaked into: ${out}`);
    }
  });
});
