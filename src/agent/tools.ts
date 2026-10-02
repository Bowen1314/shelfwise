import type { ToolDef } from "../qloo/types.js";
import { schemaForLlm } from "../qloo/validate.js";
import type { ToolSpec } from "./llm.js";

export const SET_PLAN = "set_plan";
export const SUBMIT_REPORT = "submit_report";

export const LOCAL_TOOLS = new Set([SET_PLAN, SUBMIT_REPORT]);

const refList = (description: string, max: number) => ({
  type: "array",
  items: { type: "string" },
  minItems: 1,
  maxItems: max,
  description,
});

const setPlan: ToolSpec = {
  type: "function",
  function: {
    name: SET_PLAN,
    description: "Show the user your plan as a short checklist. Call once, before your first Qloo tool call.",
    parameters: {
      type: "object",
      additionalProperties: false,
      required: ["steps"],
      properties: {
        steps: {
          type: "array",
          minItems: 2,
          maxItems: 8,
          items: {
            type: "object",
            additionalProperties: false,
            required: ["title"],
            properties: {
              title: { type: "string", maxLength: 90, description: "Plain English, e.g. 'Find books for fans of each show'." },
              tool: { type: "string", description: "The qloo_* tool this step will use, if any." },
            },
          },
        },
      },
    },
  },
};

const submitReport: ToolSpec = {
  type: "function",
  function: {
    name: SUBMIT_REPORT,
    description:
      "Submit the finished report. Entities are chosen by their ref (e12) from tool results; titles, scores, ranks, local fit and trends are filled in by the app. " +
      "In prose fields, refer to any work/artist/person only as {e12} placeholders. Call once with the complete report.",
    parameters: {
      type: "object",
      additionalProperties: false,
      required: ["bridge_shelf", "buy_list", "programmes"],
      properties: {
        bridge_shelf: {
          type: "array",
          maxItems: 12,
          items: {
            type: "object",
            additionalProperties: false,
            required: ["loved_refs", "book_ref", "why"],
            properties: {
              loved_refs: refList("Refs of 1-3 things patrons love that you passed to Qloo as signals.", 3),
              book_ref: { type: "string", description: "Ref of one book returned by a call that used those signals." },
              why: { type: "string", maxLength: 240, description: "One line (about 25 words) on why; works as {eN} placeholders only." },
            },
          },
        },
        buy_list: {
          type: "array",
          maxItems: 20,
          description: "Best first. Order by the qloo_rank call when you ran one.",
          items: {
            type: "object",
            additionalProperties: false,
            required: ["book_ref", "rationale"],
            properties: {
              book_ref: { type: "string" },
              rationale: { type: "string", maxLength: 340, description: "One sentence of evidence-based rationale; works as {eN} placeholders only." },
            },
          },
        },
        programmes: {
          type: "array",
          minItems: 1,
          maxItems: 3,
          items: {
            type: "object",
            additionalProperties: false,
            required: ["kind", "title", "description"],
            properties: {
              kind: { type: "string", enum: ["film_night", "themed_display", "book_club", "other"] },
              title: { type: "string", maxLength: 90 },
              description: { type: "string", maxLength: 440 },
              book_refs: { type: "array", items: { type: "string" }, maxItems: 4 },
              signal_refs: { type: "array", items: { type: "string" }, maxItems: 3 },
            },
          },
        },
      },
    },
  },
};

export function buildToolSpecs(qlooTools: ToolDef[]): ToolSpec[] {
  const qloo: ToolSpec[] = qlooTools.map((t) => ({
    type: "function",
    function: { name: t.name, description: t.description, parameters: schemaForLlm(t.inputSchema) },
  }));
  return [setPlan, ...qloo, submitReport];
}
