#!/usr/bin/env node
// Checks the configured OpenAI-compatible endpoint (Nebius Token Factory by default) before you rely on it:
//   1. GET  {base}/models?verbose=true  -> prints `supported_features` for the configured model
//   2. one tiny tool-calling round trip (model asks for a tool, we answer, model finishes)
//   3. a forced tool_choice call (the agent forces `submit_report` when it runs out of budget)
// Exit codes: 0 = tool calling works, 1 = it does not, 2 = not configured.
// It never prints the API key. Run: npm run check:llm   (needs NEBIUS_API_KEY in .env or the environment)
// Only NEBIUS_API_KEY is read as the key, and the other settings are SHELFWISE_LLM_*: generic names such as LLM_API_KEY
// or OPENAI_API_KEY often belong to another tool, and would be sent to the endpoint as a Bearer token.

try {
  process.loadEnvFile();
} catch {
  /* no .env file: fine */
}

const DEFAULT_BASE = "https://api.tokenfactory.nebius.com/v1/";
const DEFAULT_MODEL = "nvidia/nemotron-3-super-120b-a12b";

const base = ((process.env.SHELFWISE_LLM_BASE_URL || "").trim() || DEFAULT_BASE).replace(/\/?$/, "/");
const key = (process.env.NEBIUS_API_KEY || "").trim();
const model = (process.env.SHELFWISE_LLM_MODEL || "").trim() || DEFAULT_MODEL;
const timeoutMs = Number(process.env.SHELFWISE_LLM_TIMEOUT_MS) > 0 ? Number(process.env.SHELFWISE_LLM_TIMEOUT_MS) : 90_000;
let extraBody = {};
if (process.env.SHELFWISE_LLM_EXTRA_BODY?.trim()) {
  try {
    extraBody = JSON.parse(process.env.SHELFWISE_LLM_EXTRA_BODY);
  } catch {
    console.warn("! SHELFWISE_LLM_EXTRA_BODY is not valid JSON; ignoring it.");
  }
}

if (!key) {
  console.error("Not configured: set NEBIUS_API_KEY in .env or the environment.");
  console.error(`Base URL: ${base}\nModel:    ${model}`);
  process.exit(2);
}

console.log(`Base URL: ${base}`);
console.log(`Model:    ${model}`);

async function api(path, init = {}) {
  const started = Date.now();
  const res = await fetch(new URL(path, base), {
    ...init,
    headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json", Accept: "application/json", ...(init.headers || {}) },
    signal: AbortSignal.timeout(timeoutMs),
  });
  const text = await res.text();
  let json;
  try {
    json = JSON.parse(text);
  } catch {
    json = undefined;
  }
  return { status: res.status, ok: res.ok, json, text, ms: Date.now() - started };
}

const brief = (r) => `HTTP ${r.status}: ${(r.json?.error?.message || r.json?.message || r.text || "").toString().slice(0, 300)}`;

// ---- 1. models
try {
  const r = await api("models?verbose=true");
  if (!r.ok) {
    console.warn(`! Could not list models (${brief(r)}). Continuing.`);
  } else {
    const list = Array.isArray(r.json?.data) ? r.json.data : [];
    const exact = list.find((m) => m.id === model);
    const loose = exact ?? list.find((m) => String(m.id).toLowerCase() === model.toLowerCase());
    console.log(`Models endpoint: ${list.length} models (${r.ms} ms)`);
    if (!loose) {
      const near = list.filter((m) => /nemotron/i.test(String(m.id))).map((m) => m.id);
      console.warn(`! "${model}" is not in the model list for this key.${near.length ? ` Nemotron models listed: ${near.join(", ")}` : ""}`);
    } else {
      if (!exact) console.warn(`! The listed id is "${loose.id}" (different capitalisation); use it exactly.`);
      const features = loose.supported_features ?? loose.features ?? undefined;
      console.log(`supported_features for ${loose.id}: ${features === undefined ? "(not reported by this endpoint)" : JSON.stringify(features)}`);
      if (Array.isArray(features) && !features.some((f) => /tool|function/i.test(String(f)))) {
        console.warn("! The model does not advertise tool/function calling; Shelfwise needs it.");
      }
    }
  }
} catch (e) {
  console.warn(`! Could not list models: ${e instanceof Error ? e.message : e}`);
}

// ---- 2. tool-calling round trip
const tools = [
  {
    type: "function",
    function: {
      name: "add",
      description: "Add two integers and return the sum.",
      parameters: { type: "object", properties: { a: { type: "integer" }, b: { type: "integer" } }, required: ["a", "b"], additionalProperties: false },
    },
  },
];

async function chat(messages, toolChoice) {
  // Deliberately no `parallel_tool_calls` and no JSON mode: Shelfwise does not depend on either.
  return api("chat/completions", {
    method: "POST",
    body: JSON.stringify({ model, messages, tools, ...(toolChoice ? { tool_choice: toolChoice } : {}), temperature: 0, max_tokens: 400, stream: false, ...extraBody }),
  });
}

const message = (r) => r.json?.choices?.[0]?.message;
let failed = false;

try {
  const user = { role: "user", content: "What is 17 plus 25? Use the add tool, then tell me the answer." };
  const first = await chat([user], "auto");
  if (!first.ok) throw new Error(brief(first));
  const m1 = message(first);
  const call = m1?.tool_calls?.[0];
  if (!call) throw new Error(`the model answered without calling the tool (finish_reason ${first.json?.choices?.[0]?.finish_reason}); content: ${String(m1?.content ?? "").slice(0, 120)}`);
  const n = m1.tool_calls.length;
  let args;
  try {
    args = JSON.parse(call.function.arguments);
  } catch {
    throw new Error(`tool call arguments are not JSON: ${String(call.function.arguments).slice(0, 120)}`);
  }
  console.log(`Round trip 1/2: model called ${call.function.name}(${JSON.stringify(args)}) [${n} tool call${n === 1 ? "" : "s"}] in ${first.ms} ms`);
  const sum = Number(args.a) + Number(args.b);
  const followUp = [
    user,
    { role: "assistant", content: m1.content ?? null, tool_calls: m1.tool_calls },
    ...m1.tool_calls.map((tc) => ({ role: "tool", tool_call_id: tc.id, content: JSON.stringify({ sum }) })),
  ];
  const second = await chat(followUp, "auto");
  if (!second.ok) throw new Error(brief(second));
  const text = String(message(second)?.content ?? "");
  console.log(`Round trip 2/2: final answer in ${second.ms} ms: ${text.replace(/\s+/g, " ").slice(0, 140)}`);
  if (!text.includes(String(sum))) console.warn(`! The final answer does not mention ${sum}; check the model's tool-result handling.`);
} catch (e) {
  failed = true;
  console.error(`x Tool-calling round trip FAILED: ${e instanceof Error ? e.message : e}`);
}

// ---- 3. forced tool_choice
try {
  const r = await chat([{ role: "user", content: "Add 2 and 3." }], { type: "function", function: { name: "add" } });
  if (!r.ok) throw new Error(brief(r));
  const c = message(r)?.tool_calls?.[0];
  if (c?.function?.name !== "add") throw new Error("the model did not return the forced tool call");
  console.log(`Forced tool_choice: ok (${r.ms} ms)`);
} catch (e) {
  console.warn(`! Forced tool_choice did not work: ${e instanceof Error ? e.message : e}`);
  console.warn("  Shelfwise falls back to a single remaining tool plus an instruction, so this is not fatal.");
}

if (failed) {
  console.error("\nResult: tool calling is NOT working with this endpoint/model. Try another model (see README) or set SHELFWISE_LLM_EXTRA_BODY.");
  process.exit(1);
}
console.log("\nResult: OK. Tool calling works with this endpoint and model.");
