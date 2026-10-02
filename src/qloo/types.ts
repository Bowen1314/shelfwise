import type { ToolStatus } from "../shared/types.js";

export type JsonObject = Record<string, unknown>;

/** A tool as published by `qloo mcp` (tools/list). */
export interface ToolDef {
  name: string;
  title?: string;
  description: string;
  inputSchema: JsonObject;
}

export interface QlooError {
  code: string;
  layer?: string;
  retryable: boolean;
  recovery: string;
}

/**
 * The result envelope every Qloo workflow tool returns (schema_version "1.0-preview.1").
 * Only `status` is guaranteed; `results`/`series`/`interpretation` shapes vary per tool and are read defensively.
 */
export interface QlooEnvelope extends JsonObject {
  schema_version?: string;
  operation?: string;
  status: ToolStatus;
  summary?: string;
  interpretation?: unknown;
  resolution?: unknown;
  results?: unknown;
  series?: unknown;
  result_count?: number;
  warnings?: string[];
  error?: QlooError;
  provenance?: { requests?: { method?: string; path: string; query: unknown }[] } & JsonObject;
  /** Set only on placeholder fixtures. */
  fixture?: boolean;
}

export interface CallOptions {
  signal?: AbortSignal;
  timeoutMs?: number;
}

/** The surface the agent needs from Qloo. Implemented by the real MCP client, the fixtures, and test fakes. */
export interface QlooToolClient {
  listTools(): Promise<ToolDef[]>;
  /** Whether the server is configured to run live calls (no network). */
  readiness(): Promise<{ ready: boolean; detail?: string }>;
  call(name: string, args: JsonObject, opts?: CallOptions): Promise<QlooEnvelope>;
  /** True when the child process / backend is currently connected. null when not applicable. */
  isUp(): boolean | null;
  restarts(): number;
  close(): Promise<void>;
}

export function syntheticError(
  operation: string,
  code: string,
  summary: string,
  retryable: boolean,
  recovery: string,
): QlooEnvelope {
  return {
    schema_version: "1.0-preview.1",
    operation,
    status: "error",
    summary,
    results: [],
    result_count: 0,
    error: { code, layer: "shelfwise", retryable, recovery },
  };
}
