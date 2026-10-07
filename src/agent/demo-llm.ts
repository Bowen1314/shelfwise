import { TREND_ENTITY_TYPES } from "../qloo/validate.js";
import type { ChatMessage, ChatRequest, ChatResponse, LlmClient, ToolCall } from "./llm.js";

/**
 * PLACEHOLDER planner for sample-data mode when no LLM key is configured (DEMO_FIXTURES=1 and no NEBIUS_API_KEY).
 *
 * It is a rule-based script, not a language model: it reads the same tool-result digests a real model would see and
 * emits the same tool calls and the same submit_report arguments. Its output still passes through the evidence
 * guard. It exists so the UI can be exercised end to end without keys; it is never used in live mode.
 */

type Json = Record<string, unknown>;

interface CallInfo {
  id: string;
  tool: string;
  args: Json;
  digest?: Json;
}

const FORM_PREFIX = "New request from library staff";
const NON_CYCLE_PREFIXES = ["The user answered", "Now call submit_report", "Out of budget", "That report was not accepted"];

let idCounter = 0;
const callId = (): string => `demo_${(idCounter += 1)}`;
const call = (name: string, args: Json): ToolCall => ({ id: callId(), type: "function", function: { name, arguments: JSON.stringify(args) } });

function safeJson(text: string): Json | undefined {
  try {
    const v = JSON.parse(text) as unknown;
    return v && typeof v === "object" && !Array.isArray(v) ? (v as Json) : undefined;
  } catch {
    return undefined;
  }
}

function collectCalls(messages: ChatMessage[], from: number): CallInfo[] {
  const byId = new Map<string, CallInfo>();
  const order: CallInfo[] = [];
  for (let i = from; i < messages.length; i++) {
    const m = messages[i]!;
    if (m.role === "assistant" && m.tool_calls) {
      for (const tc of m.tool_calls) {
        const info: CallInfo = { id: tc.id, tool: tc.function.name, args: safeJson(tc.function.arguments) ?? {} };
        byId.set(tc.id, info);
        order.push(info);
      }
    } else if (m.role === "tool") {
      const info = byId.get(m.tool_call_id);
      const d = safeJson(m.content);
      if (info && d) info.digest = d;
    }
  }
  return order;
}

interface FormInfo {
  place: string;
  demographic?: string;
  titleCount: number;
  interests: string;
}

function parseForm(content: string): FormInfo {
  const place = /^Place: (.+)$/m.exec(content)?.[1]?.trim() ?? "";
  const demographic = /Use demographic "([^"]+)"/.exec(content)?.[1];
  const titleCount = Number(/Titles to buy or feature: (\d+)/.exec(content)?.[1] ?? 8);
  const interests = /"""\n([\s\S]*?)\n"""/.exec(content)?.[1] ?? "";
  return { place, ...(demographic ? { demographic } : {}), titleCount, interests };
}

const splitInterests = (text: string): string[] =>
  [...new Set(text.split(/[,;\n]| and /i).map((s) => s.trim()).filter((s) => s.length > 1))].slice(0, 4);

const ORDINALS = ["first", "second", "third", "fourth", "fifth", "sixth", "seventh", "eighth", "ninth", "tenth"];
const NUMBER_WORDS = ["none", "one", "two", "three", "four"];

const arr = (v: unknown): Json[] => (Array.isArray(v) ? (v as Json[]) : []);
const str = (v: unknown): string => (typeof v === "string" ? v : "");

interface Rec {
  sigRef: string;
  sigName: string;
  sigType: string;
  books: { ref: string; name: string; id: string }[];
}

function recsFrom(calls: CallInfo[]): Rec[] {
  const out = new Map<string, Rec>();
  for (const c of calls) {
    if (c.tool !== "qloo_recommend" || !c.digest || (c.digest["status"] !== "ok" && c.digest["status"] !== "partial")) continue;
    const inputs = arr(c.digest["resolved_inputs"]);
    if (inputs.length !== 1) continue;
    const sig = inputs[0]!;
    out.set(str(sig["ref"]), {
      sigRef: str(sig["ref"]),
      sigName: str(sig["name"]),
      sigType: str(sig["type"]),
      books: arr(c.digest["results"]).map((r) => ({ ref: str(r["ref"]), name: str(r["name"]), id: str(r["id"]) })),
    });
  }
  return [...out.values()];
}

function shortlist(recs: Rec[], max: number): string[] {
  const score = new Map<string, number>();
  for (const r of recs) r.books.forEach((b, i) => score.set(b.ref, (score.get(b.ref) ?? 0) + 10 - i));
  return [...score.entries()].sort((a, b) => b[1] - a[1]).slice(0, max).map(([ref]) => ref);
}

export class ScriptedDemoLlm implements LlmClient {
  readonly provider = "scripted-demo";
  readonly model = "scripted-demo-planner (placeholder, not a language model)";
  readonly scripted = true;

  async chat(req: ChatRequest): Promise<ChatResponse> {
    const msgs = req.messages.filter((m) => m.role !== "system");
    const firstForm = msgs.find((m) => m.role === "user" && m.content.startsWith(FORM_PREFIX));
    if (!firstForm || firstForm.role !== "user") return { content: "Sample-data mode needs the intake form first.", toolCalls: [] };
    const form = parseForm(firstForm.content);

    let start = -1;
    msgs.forEach((m, i) => {
      if (m.role === "user" && !NON_CYCLE_PREFIXES.some((p) => m.content.startsWith(p))) start = i;
    });
    const startMsg = msgs[start];
    const followUp = startMsg && startMsg.role === "user" && !startMsg.content.startsWith(FORM_PREFIX) ? startMsg.content.toLowerCase() : undefined;

    let demographic = form.demographic;
    const includeTags: string[] = [];
    let shorter = false;
    if (followUp) {
      if (/teen|young adult|youth/.test(followUp)) demographic = "teens";
      if (/translat/.test(followUp)) includeTags.push("translated fiction");
      shorter = /shorter|fewer|less/.test(followUp);
      if (!/teen|young adult|youth|translat|shorter|fewer|less/.test(followUp)) {
        return {
          content: "In sample-data mode I can re-run for teens, for translated fiction, or shorten the list. A live model handles open-ended follow-ups.",
          toolCalls: [],
        };
      }
    }

    // Resolutions the user gave (all of them, whole conversation).
    const mapping = new Map<string, string>();
    const skipped = new Set<string>();
    for (const m of msgs) {
      if (m.role !== "user" || !m.content.startsWith("The user answered")) continue;
      for (const line of m.content.split("\n")) {
        const pick = /^- "([^"]+)".*Use this Qloo (?:entity|tag) id: (\S+)/.exec(line);
        if (pick) mapping.set(pick[1]!, pick[2]!);
        const skip = /^- "([^"]+)".*(?:chose to skip|treat it as skipped)/.exec(line);
        if (skip) skipped.add(skip[1]!);
      }
    }
    const signals = splitInterests(form.interests).filter((s) => !skipped.has(s));
    const cycle = collectCalls(msgs, start + 1);
    const allCalls = collectCalls(msgs, 0);
    const baseArgs = (): Json => ({ target_type: "book", signal_location: form.place, ...(demographic ? { demographic } : {}), ...(includeTags.length ? { include_tags: includeTags } : {}), limit: 8 });

    // Forced / final: build the report.
    const onlySubmit = req.tools.length === 1 && req.tools[0]?.function.name === "submit_report";
    const recCalls = cycle.filter((c) => c.tool === "qloo_recommend");
    const firstSignal = (c: CallInfo): string => (Array.isArray(c.args["signals"]) ? String((c.args["signals"] as unknown[])[0] ?? "") : "");
    const matches = (s: string, c: CallInfo): boolean => [s, mapping.get(s)].includes(firstSignal(c));
    const doneSignals = (s: string): number => recCalls.filter((c) => matches(s, c) && c.digest && c.digest["status"] !== "needs_input").length;
    const attempts = (s: string): number => recCalls.filter((c) => matches(s, c)).length;
    const pending = signals.filter((s) => doneSignals(s) === 0 && attempts(s) < 2);

    if (!onlySubmit) {
      if (shorter && cycle.length === 0) return this.report(allCalls, Math.max(3, Math.floor(form.titleCount / 2)));
      if (cycle.length === 0) {
        return {
          content: `Checking Qloo's sample taste data for ${signals.length} thing${signals.length === 1 ? "" : "s"} patrons are into.`,
          toolCalls: [
            call("set_plan", {
              steps: [
                { title: "Find books for fans of each thing patrons love", tool: "qloo_recommend" },
                { title: "Rank the shortlist for this audience", tool: "qloo_rank" },
                { title: "Check local fit for the top picks", tool: "qloo_where_popular" },
                { title: "Check whether interest in those signals is rising", tool: "qloo_trends" },
                { title: "Write the shelf, buy list and programme ideas" },
              ],
            }),
            ...signals.map((s) => call("qloo_recommend", { ...baseArgs(), signals: [mapping.get(s) ?? s] })),
          ],
        };
      }
      if (pending.length > 0) {
        return { content: "Retrying with the choices you made.", toolCalls: pending.map((s) => call("qloo_recommend", { ...baseArgs(), signals: [mapping.get(s) ?? s] })) };
      }
      const recs = recsFrom(cycle);
      if (!cycle.some((c) => c.tool === "qloo_rank")) {
        const list = shortlist(recs, 8);
        if (list.length === 0) {
          return { content: "Qloo's sample data returned nothing for those signals. Try one of the sample inputs.", toolCalls: [] };
        }
        return {
          content: "Ranking the shortlist for this audience.",
          toolCalls: [call("qloo_rank", { option_type: "book", options: list, signals: recs.slice(0, 2).map((r) => r.sigRef), signal_location: form.place, ...(demographic ? { demographic } : {}) })],
        };
      }
      if (!cycle.some((c) => c.tool === "qloo_where_popular" || c.tool === "qloo_trends")) {
        const rankDigest = cycle.find((c) => c.tool === "qloo_rank")?.digest;
        const ranked = arr(rankDigest?.["results"]).map((r) => str(r["ref"]));
        const calls: ToolCall[] = [];
        ranked.slice(0, 2).forEach((ref) => calls.push(call("qloo_where_popular", { entity: ref, entity_type: "book", within: form.place })));
        const end = new Date().toISOString().slice(0, 10);
        const startDate = `${Number(end.slice(0, 4)) - 1}${end.slice(4)}`;
        // Qloo has no trend data for books: trend the signals patrons love, one call per supported type.
        const byType = new Map<string, string[]>();
        for (const r of recs) {
          if (!(TREND_ENTITY_TYPES as readonly string[]).includes(r.sigType)) continue;
          byType.set(r.sigType, [...(byType.get(r.sigType) ?? []), r.sigRef].slice(0, 5));
        }
        for (const [type, refs] of byType) calls.push(call("qloo_trends", { entities: refs, entity_type: type, start_date: startDate, end_date: end, limit: 20 }));
        if (recs.length >= 2) calls.push(call("qloo_compare_audiences", { group_a: [recs[0]!.sigRef], group_b: [recs[1]!.sigRef], target_type: "book", limit: 5 }));
        return { content: "Checking local fit, trends and a bridging title.", toolCalls: calls };
      }
    }
    return this.report(allCalls, form.titleCount);
  }

  /** Build submit_report arguments from the digests. Titles are only ever referenced by ref/placeholder. */
  private report(calls: CallInfo[], count: number): ChatResponse {
    const recs = recsFrom(calls);
    const rankCall = [...calls].reverse().find((c) => c.tool === "qloo_rank" && c.digest?.["status"] === "ok");
    const rankedRefs = arr(rankCall?.digest?.["results"]).map((r) => str(r["ref"]));
    const orderedRefs = rankedRefs.length ? rankedRefs : shortlist(recs, count);
    const countFor = (ref: string): number => recs.filter((r) => r.books.some((b) => b.ref === ref)).length;
    const trendOf = new Map<string, string>();
    const localOf = new Set<string>();
    for (const c of calls) {
      for (const t of arr(c.digest?.["trends"])) trendOf.set(str(t["ref"]), str(t["direction"]));
      const entity = arr(c.digest?.["resolved_inputs"])[0];
      if (c.tool === "qloo_where_popular" && entity && Number(((c.digest?.["local_fit"] as Json | undefined)?.["areas"]) ?? 0) > 0) localOf.add(str(entity["ref"]));
    }

    const buy = orderedRefs.slice(0, count).map((ref, i) => {
      const bits = [`{${ref}} ranked ${ORDINALS[i] ?? "high"} for this audience`];
      const k = countFor(ref);
      if (k > 0) bits.push(`and came back for ${NUMBER_WORDS[Math.min(k, 4)]} of your signals`);
      if (localOf.has(ref)) bits.push("and local heat returned for your area");
      // A direction is only ever said about the signal its trends entry names, never about the book.
      const trended = recs.find((r) => r.books.some((b) => b.ref === ref) && trendOf.has(r.sigRef));
      const dir = trended ? trendOf.get(trended.sigRef) : undefined;
      if (trended && dir && dir !== "unknown") bits.push(`while interest in {${trended.sigRef}} is ${dir}`);
      return { book_ref: ref, rationale: `${bits.join(", ")}.` };
    });

    const used = new Map<string, number>();
    const cards: { loved_refs: string[]; book_ref: string; why: string }[] = [];
    for (const r of recs) {
      for (const b of r.books.slice(0, 2)) {
        if ((used.get(b.ref) ?? 0) >= 2 || cards.length >= 8) continue;
        used.set(b.ref, (used.get(b.ref) ?? 0) + 1);
        const others = recs.filter((o) => o.sigRef !== r.sigRef && o.books.some((x) => x.ref === b.ref));
        cards.push({
          loved_refs: [r.sigRef],
          book_ref: b.ref,
          why: `{${b.ref}} came back for fans of {${r.sigRef}}${others[0] ? `, and also for fans of {${others[0].sigRef}}` : ""}.`,
        });
      }
    }

    const top = orderedRefs[0];
    const second = orderedRefs[1];
    const lead = recs[0];
    const programmes: Record<string, unknown>[] = [];
    if (lead && top) {
      programmes.push({
        kind: "film_night",
        title: `A {${lead.sigRef}} night with {${top}} on the table`,
        description: `Screen an episode or a clip of {${lead.sigRef}}, then invite people to take home {${top}}${second ? ` or {${second}}` : ""}, both of which Qloo returned for this audience.`,
        book_refs: [top, ...(second ? [second] : [])],
        signal_refs: [lead.sigRef],
      });
    }
    if (orderedRefs.length > 0) {
      const shown = orderedRefs.slice(0, 3).map((r) => `{${r}}`);
      const listed = shown.length > 1 ? `${shown.slice(0, -1).join(", ")} and ${shown[shown.length - 1]}` : shown[0];
      programmes.push({
        kind: "themed_display",
        title: "If you liked it on screen: a face-out display",
        description: `Face out ${listed} with the shelf-talkers from this report beside the matching titles.`,
        book_refs: orderedRefs.slice(0, 3),
        signal_refs: recs.slice(0, 2).map((r) => r.sigRef),
      });
    }
    if (top) {
      programmes.push({
        kind: "book_club",
        title: "Book club pick: {" + top + "}",
        description: `Offer {${top}} as a pick for readers who already love {${lead?.sigRef ?? top}}, and ask the group which other screen favourites they would like on the next list.`,
        book_refs: [top],
        signal_refs: lead ? [lead.sigRef] : [],
      });
    }
    return {
      content: "",
      toolCalls: [call("submit_report", { bridge_shelf: cards, buy_list: buy, programmes })],
    };
  }
}
