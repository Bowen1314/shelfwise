import { ScriptedDemoLlm } from "../agent/demo-llm.js";
import { type LlmClient, OpenAiCompatLlm } from "../agent/llm.js";
import { type Config, LLM_KEY_ENV } from "./config.js";

export type PlannerLlm = LlmClient & { provider?: string; model?: string; scripted?: boolean };

/**
 * Which planner drives the agent loop. This is the single decision point:
 *  - a model key present (NEBIUS_API_KEY) -> the real OpenAI-compatible client, in sample-data mode too;
 *  - no key, sample-data mode -> the scripted placeholder (it never makes a network request);
 *  - no key, live mode -> an inert client that is never called (runs are refused as "not configured").
 */
export function createLlm(config: Config, sample: boolean): PlannerLlm {
  if (config.llm.apiKey) {
    return new OpenAiCompatLlm({
      baseUrl: config.llm.baseUrl,
      apiKey: config.llm.apiKey,
      model: config.llm.model,
      timeoutMs: config.llm.timeoutMs,
      maxTokens: config.llm.maxTokens,
      ...(config.llm.extraBody ? { extraBody: config.llm.extraBody } : {}),
    });
  }
  if (sample) return new ScriptedDemoLlm();
  return new OpenAiCompatLlm({ baseUrl: config.llm.baseUrl, apiKey: "", model: config.llm.model, timeoutMs: config.llm.timeoutMs, maxTokens: config.llm.maxTokens });
}

export interface LlmDescription {
  provider: string;
  model: string;
  scripted: boolean;
}

/** What /api/health reports AND what the startup log prints, from the same object, so they cannot disagree. */
export function describeLlm(llm: PlannerLlm, config: Config): LlmDescription {
  return { provider: llm.provider ?? "openai-compatible", model: llm.model ?? config.llm.model, scripted: llm.scripted === true };
}

/** Host (and port) of the model endpoint. Never includes credentials, a path or a query string. */
export function baseUrlHost(baseUrl: string): string {
  try {
    return new URL(baseUrl).host || "(no host)";
  } catch {
    return "(invalid base URL)";
  }
}

/** The mode and planner line(s) printed at startup. Contains no part of any key. */
export function startupLines(config: Config, sample: boolean, llm: PlannerLlm): string[] {
  const d = describeLlm(llm, config);
  const host = baseUrlHost(config.llm.baseUrl);
  if (sample) {
    const planner = d.scripted
      ? `scripted placeholder (not a language model; no model request is ever made. Set ${LLM_KEY_ENV} to use a real model on sample data)`
      : `REAL language model ${d.model} via ${host} (${LLM_KEY_ENV} is set), working on SAMPLE Qloo data`;
    return [`Mode: SAMPLE DATA (DEMO_FIXTURES) - not live Qloo results. Planner: ${planner}`];
  }
  return [`Mode: live. Model: ${d.model} via ${host}${config.llm.apiKey ? "" : ` (${LLM_KEY_ENV} is not set: runs are refused)`}`];
}
