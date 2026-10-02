import { Ajv, type ValidateFunction } from "ajv";
import type { JsonObject, ToolDef } from "./types.js";

/**
 * `qloo mcp` does not validate arguments itself: bad input surfaces only as an opaque MCP_ADAPTER_FAILURE.
 * We validate against the schemas the server publishes so the model gets a precise, correctable message.
 */
const ajv = new Ajv({ allErrors: true, strict: false, coerceTypes: false });

const compiled = new WeakMap<object, ValidateFunction>();

function validatorFor(tool: ToolDef): ValidateFunction {
  let v = compiled.get(tool);
  if (!v) {
    v = ajv.compile(tool.inputSchema);
    compiled.set(tool, v);
  }
  return v;
}

const DATE = /^\d{4}-\d{2}-\d{2}$/;

export function isCalendarDate(value: string): boolean {
  if (!DATE.test(value)) return false;
  const [y, m, d] = value.split("-").map(Number) as [number, number, number];
  if (m < 1 || m > 12 || d < 1) return false;
  const leap = y % 4 === 0 && (y % 100 !== 0 || y % 400 === 0);
  const days = [31, leap ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
  return d <= (days[m - 1] ?? 0);
}

export interface ValidationResult {
  ok: boolean;
  errors: string[];
}

/** Schema validation plus the few semantic rules the harness enforces by throwing (which would hide the reason). */
export function validateToolArgs(tool: ToolDef, args: JsonObject): ValidationResult {
  const errors: string[] = [];
  const v = validatorFor(tool);
  if (!v(args)) {
    for (const e of v.errors ?? []) {
      const where = e.instancePath ? e.instancePath.replace(/^\//, "").replace(/\//g, ".") : "(arguments)";
      if (e.keyword === "additionalProperties") {
        errors.push(`${where}: unknown argument "${String((e.params as { additionalProperty?: string }).additionalProperty)}"`);
      } else if (e.keyword === "required") {
        errors.push(`missing required argument "${String((e.params as { missingProperty?: string }).missingProperty)}"`);
      } else {
        errors.push(`${where} ${e.message ?? "is invalid"}`);
      }
    }
  }
  if (tool.name === "qloo_trends") {
    const start = args["start_date"];
    const end = args["end_date"];
    if (typeof start === "string" && typeof end === "string") {
      if (!isCalendarDate(start) || !isCalendarDate(end)) errors.push("start_date and end_date must be real calendar dates (YYYY-MM-DD)");
      else if (start > end) errors.push("start_date must be on or before end_date");
    }
  }
  if ((tool.name === "qloo_recommend" || tool.name === "qloo_rank") && args["demographic"] && !args["signal_location"]) {
    errors.push('"demographic" requires "signal_location" (Qloo needs the audience geography to be explicit)');
  }
  return { ok: errors.length === 0, errors };
}

/** Remove keywords some OpenAI-compatible servers reject in tool schemas; keep everything that constrains values. */
export function schemaForLlm(schema: unknown): unknown {
  if (Array.isArray(schema)) return schema.map(schemaForLlm);
  if (schema && typeof schema === "object") {
    const out: JsonObject = {};
    for (const [k, v] of Object.entries(schema as JsonObject)) {
      if (k === "examples" || k === "$schema" || k === "uniqueItems") continue;
      out[k] = schemaForLlm(v);
    }
    return out;
  }
  return schema;
}
