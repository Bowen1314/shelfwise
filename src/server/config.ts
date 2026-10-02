export interface Config {
  port: number;
  host: string;
  /** Number of trusted proxy hops; 0 = ignore forwarding headers. */
  trustProxy: number;
  demoFixtures: boolean;
  qlooApiKey: string | undefined;
  llm: {
    baseUrl: string;
    apiKey: string | undefined;
    model: string;
    timeoutMs: number;
    maxTokens: number;
    extraBody: Record<string, unknown> | undefined;
  };
  agent: {
    maxSteps: number;
    maxToolCalls: number;
    maxRetries: number;
    retryBaseMs: number;
    maxSessionToolCalls: number;
    maxReportRepairs: number;
    qlooTimeoutMs: number;
    qlooConcurrency: number;
  };
  limits: {
    runsPerHour: number;
    messagesPerHour: number;
    dailyCallBudget: number;
    maxConcurrentRuns: number;
    maxQueue: number;
    queueWaitTimeoutSec: number;
    maxSessionFollowUps: number;
  };
  cache: { ttlMs: number; maxEntries: number };
  /** Parse errors found while reading the environment (reported by /api/health, never thrown). */
  parseProblems: string[];
}

/**
 * The ONLY environment variable that can supply the model key. Generic names such as LLM_API_KEY or OPENAI_API_KEY are
 * deliberately not read: they commonly belong to some other tool in the same shell, and Shelfwise would send that
 * tool's key to Nebius as a Bearer token. The other model settings carry a SHELFWISE_ prefix for the same reason.
 */
export const LLM_KEY_ENV = "NEBIUS_API_KEY";

export const DEFAULT_LLM_BASE_URL = "https://api.tokenfactory.nebius.com/v1/";
export const DEFAULT_LLM_MODEL = "nvidia/nemotron-3-super-120b-a12b";

type Env = Record<string, string | undefined>;

export function loadConfig(env: Env = process.env): Config {
  const parseProblems: string[] = [];
  const int = (key: string, dflt: number, min: number, max: number): number => {
    const raw = env[key];
    if (raw === undefined || raw.trim() === "") return dflt;
    const n = Number(raw);
    if (!Number.isInteger(n) || n < min || n > max) {
      parseProblems.push(`${key} must be an integer between ${min} and ${max} (got "${raw}"); using ${dflt}.`);
      return dflt;
    }
    return n;
  };
  const truthy = (v: string | undefined): boolean => ["1", "true", "yes", "on"].includes((v ?? "").trim().toLowerCase());

  let trustProxy = 0;
  const tp = (env["TRUST_PROXY"] ?? "").trim().toLowerCase();
  if (tp === "true" || tp === "yes" || tp === "on") trustProxy = 1;
  else if (/^\d+$/.test(tp)) trustProxy = Math.min(10, Number(tp));

  let extraBody: Record<string, unknown> | undefined;
  const rawExtra = env["SHELFWISE_LLM_EXTRA_BODY"]?.trim();
  if (rawExtra) {
    try {
      const parsed = JSON.parse(rawExtra) as unknown;
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) extraBody = parsed as Record<string, unknown>;
      else parseProblems.push("SHELFWISE_LLM_EXTRA_BODY must be a JSON object; ignoring it.");
    } catch {
      parseProblems.push("SHELFWISE_LLM_EXTRA_BODY is not valid JSON; ignoring it.");
    }
  }

  const nonEmpty = (v: string | undefined): string | undefined => (v && v.trim() ? v.trim() : undefined);

  return {
    port: int("PORT", 8790, 1, 65535),
    host: nonEmpty(env["HOST"]) ?? "127.0.0.1",
    trustProxy,
    demoFixtures: truthy(env["DEMO_FIXTURES"]),
    qlooApiKey: nonEmpty(env["QLOO_API_KEY"]),
    llm: {
      baseUrl: nonEmpty(env["SHELFWISE_LLM_BASE_URL"]) ?? DEFAULT_LLM_BASE_URL,
      apiKey: nonEmpty(env[LLM_KEY_ENV]),
      model: nonEmpty(env["SHELFWISE_LLM_MODEL"]) ?? DEFAULT_LLM_MODEL,
      timeoutMs: int("SHELFWISE_LLM_TIMEOUT_MS", 90_000, 5_000, 600_000),
      maxTokens: int("SHELFWISE_LLM_MAX_TOKENS", 4096, 256, 32_768),
      extraBody,
    },
    agent: {
      maxSteps: int("AGENT_MAX_STEPS", 14, 2, 40),
      maxToolCalls: int("AGENT_MAX_TOOL_CALLS", 24, 1, 80),
      maxRetries: int("AGENT_MAX_RETRIES", 2, 0, 5),
      retryBaseMs: int("AGENT_RETRY_BASE_MS", 600, 0, 10_000),
      maxSessionToolCalls: int("AGENT_MAX_SESSION_TOOL_CALLS", 60, 1, 400),
      maxReportRepairs: int("AGENT_MAX_REPORT_REPAIRS", 2, 0, 5),
      qlooTimeoutMs: int("QLOO_CALL_TIMEOUT_MS", 45_000, 1_000, 300_000),
      qlooConcurrency: int("QLOO_CONCURRENCY", 3, 1, 10),
    },
    limits: {
      runsPerHour: int("RATE_LIMIT_RUNS_PER_HOUR", 6, 1, 10_000),
      messagesPerHour: int("RATE_LIMIT_MESSAGES_PER_HOUR", 40, 1, 10_000),
      dailyCallBudget: int("QLOO_DAILY_CALL_BUDGET", 1500, 1, 1_000_000),
      maxConcurrentRuns: int("MAX_CONCURRENT_RUNS", 2, 1, 32),
      maxQueue: int("MAX_QUEUE", 8, 0, 200),
      queueWaitTimeoutSec: int("QUEUE_WAIT_TIMEOUT_SEC", 120, 5, 1800),
      maxSessionFollowUps: int("MAX_SESSION_FOLLOWUPS", 12, 1, 100),
    },
    cache: { ttlMs: int("CACHE_TTL_MINUTES", 720, 1, 10_080) * 60_000, maxEntries: int("CACHE_MAX_ENTRIES", 500, 10, 100_000) },
    parseProblems,
  };
}

/**
 * What stops runs from starting. In live mode a missing key is a hard "not configured" state:
 * Shelfwise never substitutes sample data for live results. (Malformed optional settings are not blockers: they
 * fall back to their defaults and are reported as warnings at startup via `cfg.parseProblems`.)
 */
export function readinessProblems(cfg: Config): string[] {
  const problems: string[] = [];
  if (cfg.demoFixtures) return problems;
  if (!cfg.qlooApiKey) problems.push("QLOO_API_KEY is not set. Live mode needs a Qloo key (or start with DEMO_FIXTURES=1 for clearly-labelled sample data).");
  if (!cfg.llm.apiKey) problems.push(`${LLM_KEY_ENV} is not set. Live mode needs a Nebius Token Factory key.`);
  return problems;
}
