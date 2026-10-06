import {
  AGE_BANDS,
  type BridgeCard,
  type BuyEvidence,
  type BuyItem,
  type Cite,
  type FormInput,
  type ProgrammeIdea,
  type ProgrammeKind,
  type Report,
  type ReportNote,
  type TrendSummary,
} from "../shared/types.js";
import { type CallRecord, type EntityRecord, EvidenceStore, normName, toRef } from "./evidence.js";

/**
 * The no-invention guard.
 *
 * The model never types a title, score, rank, local-fit or trend value that reaches the user:
 *  - It selects entities by handle ("e12"); this module looks the entity up in the Qloo results it holds.
 *  - Every number, rank, affinity, local-fit and trend shown is joined from those same results.
 *  - The model's prose (why / rationale / programme text) may name works only through {e12} placeholders, which
 *    are replaced by the returned title. Quoted or emphasised names must match a returned name or the user's own
 *    input, and every number must appear in a Qloo result (or the user's input).
 * Anything that fails is withheld and reported back to the model for one bounded repair.
 */

export const LIMITS = { why: 240, rationale: 340, title: 90, description: 440, maxCards: 12, maxProgrammes: 3 };

export interface GuardContext {
  store: EvidenceStore;
  form: FormInput;
  /** Text the user supplied (place + interests + audience); quoted phrases matching it are allowed. */
  userText: string;
  sample: boolean;
  version: number;
  now: Date;
}

export interface GuardResult {
  report: Report;
  /** Per-item reasons for anything withheld, written for the model. */
  problems: string[];
  /** Number of submitted items that were withheld. */
  withheld: number;
  /** True when every section has at least one valid item. */
  complete: boolean;
}

type Rec = Record<string, unknown>;
const asRec = (v: unknown): Rec | undefined => (v !== null && typeof v === "object" && !Array.isArray(v) ? (v as Rec) : undefined);

// ----------------------------------------------------------------------------------------------- text

const PLACEHOLDER = /\{(e\d+)\}/g;
const QUOTED = /["“]([^"”]{2,80})["”]|\*([^*\n]{2,80})\*/g;
const NUMBER = /\d+(?:[.,]\d+)?/g;

function numbersIn(text: string): string[] {
  return (text.match(NUMBER) ?? []).map((n) => n.replace(",", "."));
}

/** Validate and expand one piece of model-written prose. */
export function checkText(
  label: string,
  value: unknown,
  max: number,
  ctx: GuardContext,
): { ok: true; text: string } | { ok: false; problems: string[] } {
  if (typeof value !== "string" || value.trim().length === 0) return { ok: false, problems: [`${label}: must be a non-empty string`] };
  const raw = value.replace(/[\u0000-\u001f\u007f]/g, " ").replace(/\s+/g, " ").trim();
  const problems: string[] = [];
  if (raw.length > max) problems.push(`${label}: too long (${raw.length} > ${max} characters)`);

  // Placeholders must refer to entities Qloo returned.
  const used = [...raw.matchAll(PLACEHOLDER)].map((m) => m[1] as string);
  for (const handle of used) if (!ctx.store.entity(handle)) problems.push(`${label}: {${handle}} is not a ref from any tool result`);
  const withoutPlaceholders = raw.replace(PLACEHOLDER, " ");
  if (/[{}]/.test(withoutPlaceholders)) problems.push(`${label}: stray braces; use only {eN} placeholders copied from result refs`);

  // Quoted / emphasised names must be names Qloo returned or the user typed.
  const known = ctx.store.knownNames();
  const userNorm = normName(ctx.userText);
  let remaining = withoutPlaceholders;
  for (const m of withoutPlaceholders.matchAll(QUOTED)) {
    const span = (m[1] ?? m[2] ?? "").trim();
    const norm = normName(span);
    if (!norm) continue;
    if (!known.has(norm) && !userNorm.includes(norm)) {
      problems.push(`${label}: "${span}" is not a title or tag that any Qloo result returned; refer to works with {eN} placeholders`);
    }
    remaining = remaining.replace(m[0], " ");
  }

  // Numbers must appear in a Qloo result or in what the user typed.
  const allowedNumbers = ctx.store.numberTokens();
  const userNumbers = new Set(numbersIn(ctx.userText));
  for (const n of numbersIn(remaining)) {
    if (!allowedNumbers.has(n) && !userNumbers.has(n)) {
      problems.push(`${label}: the number ${n} does not appear in any Qloo result; describe it in words or copy a value exactly`);
    }
  }
  if (problems.length) return { ok: false, problems };

  const expanded = raw
    .replace(PLACEHOLDER, (_, h: string) => ctx.store.entity(h)?.name ?? "")
    .replace(/\*/g, "")
    .replace(/\s+/g, " ")
    .trim();
  return { ok: true, text: expanded };
}

// ----------------------------------------------------------------------------------------------- refs

function strings(v: unknown): string[] | undefined {
  if (typeof v === "string") return [v];
  if (Array.isArray(v) && v.every((x) => typeof x === "string")) return v as string[];
  return undefined;
}

function lookup(handle: string, ctx: GuardContext): EntityRecord | undefined {
  return ctx.store.entity(handle.trim().replace(/^\{|\}$/g, ""));
}

const isReduced = (c: CallRecord): boolean => c.status === "partial" || c.status === "degraded";

function affinityText(a?: number): string {
  return a === undefined ? "" : `, affinity ${a}`;
}

function citeFor(call: CallRecord, entity: EntityRecord): Cite {
  const a = entity.appearances.find((x) => x.callId === call.callId && x.role === "result");
  const where = a?.position ? `result ${a.position} of ${a.of}${affinityText(a.affinity)}` : "returned";
  return { callId: call.callId, tool: call.tool, label: `${call.tool.replace(/^qloo_/, "")}: ${where}` };
}

// ----------------------------------------------------------------------------------------------- evidence join

export function buyEvidence(store: EvidenceStore, book: EntityRecord): { evidence: BuyEvidence; cites: Cite[] } {
  const cites: Cite[] = [];
  const recommendations: BuyEvidence["recommendations"] = [];
  const matched = new Map<string, ReturnType<typeof toRef>>();
  let reduced = false;
  let rank: BuyEvidence["rank"];
  let localFit: BuyEvidence["localFit"];
  let trend: BuyEvidence["trend"];

  for (const call of store.allCalls()) {
    if (call.status === "error" || call.status === "needs_input") continue;
    const a = book.appearances.find((x) => x.callId === call.callId && x.role === "result");
    if (call.tool === "qloo_recommend" && a?.position && a.of) {
      const signalInputs = call.resolved.filter((r) => r.field === "signals");
      const signal = signalInputs.length === 1 ? toRef(signalInputs[0]!.entity) : undefined;
      recommendations.push({
        callId: call.callId,
        ...(signal ? { signal } : {}),
        position: a.position,
        of: a.of,
        ...(a.affinity !== undefined ? { affinity: a.affinity } : {}),
      });
      if (signal) matched.set(signal.handle, signal);
      cites.push(citeFor(call, book));
      reduced ||= isReduced(call);
    } else if (call.tool === "qloo_rank" && a?.position && a.of) {
      rank = { callId: call.callId, position: a.position, of: a.of, ...(a.affinity !== undefined ? { affinity: a.affinity } : {}) };
      cites.push(citeFor(call, book));
      reduced ||= isReduced(call);
    } else if (call.tool === "qloo_where_popular" && call.local?.entity.handle === book.handle) {
      localFit = call.local;
      cites.push({ callId: call.callId, tool: call.tool, label: `where_popular: ${call.local.areas} area(s) within ${call.local.within}` });
      reduced ||= isReduced(call);
    } else if (call.tool === "qloo_trends") {
      const t = call.trends.find((x) => x.entity.handle === book.handle);
      if (t) {
        trend = t;
        cites.push({ callId: call.callId, tool: call.tool, label: `trends: ${t.direction}` });
        reduced ||= isReduced(call);
      }
    }
  }
  // Trends are checked on the things patrons love (Qloo has no trend data for books): join the latest series for
  // each matched signal.
  const signalTrends = new Map<string, TrendSummary>();
  for (const call of store.allCalls()) {
    if (call.tool !== "qloo_trends" || call.status === "error" || call.status === "needs_input") continue;
    for (const t of call.trends) if (matched.has(t.entity.handle)) signalTrends.set(t.entity.handle, t);
  }
  for (const t of signalTrends.values()) {
    if (!cites.some((c) => c.callId === t.callId)) cites.push({ callId: t.callId, tool: "qloo_trends", label: `trends: ${t.entity.name} ${t.direction}` });
  }
  return {
    evidence: {
      matchedSignals: [...matched.values()],
      recommendations,
      ...(rank ? { rank } : {}),
      ...(localFit ? { localFit } : {}),
      ...(trend ? { trend } : {}),
      ...(signalTrends.size ? { signalTrends: [...signalTrends.values()] } : {}),
      reduced,
    },
    cites,
  };
}

// ----------------------------------------------------------------------------------------------- the check

const KINDS: ProgrammeKind[] = ["film_night", "themed_display", "book_club", "other"];

export function budgetNote(form: FormInput): string | undefined {
  if (form.budget && form.avgPrice && form.avgPrice > 0) {
    const n = Math.floor(form.budget / form.avgPrice);
    return `Your figures: ${form.budget} divided by ${form.avgPrice} per title is ${n} title${n === 1 ? "" : "s"}. Qloo returns no prices; this is arithmetic on the numbers you entered.`;
  }
  return undefined;
}

/**
 * The audience a report speaks to is what was actually sent to Qloo, not what the form said: a follow-up such as
 * "make it for teens" changes the `demographic` of the next calls, and a model that forgot to pass it must not get
 * the form's label. Reads the most recent recommend/rank call that produced usable results.
 */
export function queriedAudience(store: EvidenceStore): string | undefined {
  const calls = store.allCalls();
  for (let i = calls.length - 1; i >= 0; i--) {
    const c = calls[i]!;
    if (c.tool !== "qloo_recommend" && c.tool !== "qloo_rank") continue;
    if (c.status !== "ok" && c.status !== "partial" && c.status !== "degraded") continue;
    const d = c.args["demographic"];
    return typeof d === "string" && d.trim() ? d.trim() : "";
  }
  return undefined;
}

export function audienceLabel(form: FormInput, queried?: string): { label: string; band: (typeof AGE_BANDS)[number] | undefined; formNotApplied: boolean } {
  const formBand = AGE_BANDS.find((b) => b.id === form.ageBand);
  if (queried === undefined) return { label: formBand?.label ?? "Whole community (no age focus)", band: formBand, formNotApplied: false };
  if (queried === "") {
    return { label: "Whole community (no age focus)", band: undefined, formNotApplied: Boolean(formBand?.demographic) };
  }
  const match = AGE_BANDS.find((b) => b.demographic !== null && b.demographic.toLowerCase() === queried.toLowerCase());
  return { label: match?.label ?? `Audience as sent to Qloo: ${queried}`, band: match, formNotApplied: false };
}

export function checkSubmission(raw: unknown, ctx: GuardContext): GuardResult {
  const problems: string[] = [];
  let withheld = 0;
  const sub = asRec(raw) ?? {};

  // ---- bridge shelf
  const cards: BridgeCard[] = [];
  const seenPairs = new Set<string>();
  const shelf = Array.isArray(sub["bridge_shelf"]) ? (sub["bridge_shelf"] as unknown[]) : [];
  if (!Array.isArray(sub["bridge_shelf"])) problems.push("bridge_shelf: must be an array");
  shelf.slice(0, LIMITS.maxCards).forEach((item, i) => {
    const label = `bridge_shelf[${i}]`;
    const o = asRec(item);
    const itemProblems: string[] = [];
    const lovedHandles = strings(o?.["loved_refs"] ?? o?.["loved_ref"]);
    const bookHandle = typeof o?.["book_ref"] === "string" ? (o["book_ref"] as string) : undefined;
    const loved = (lovedHandles ?? []).map((h) => lookup(h, ctx));
    const book = bookHandle ? lookup(bookHandle, ctx) : undefined;
    if (!lovedHandles?.length || lovedHandles.length > 3) itemProblems.push(`${label}.loved_refs: give 1-3 refs of things patrons love (signals you queried)`);
    loved.forEach((l, k) => {
      if (!l) itemProblems.push(`${label}.loved_refs[${k}]: ${lovedHandles?.[k]} is not a ref from any tool result`);
      else if (!ctx.store.isInput(l)) itemProblems.push(`${label}.loved_refs[${k}]: ${l.handle} was only ever a result; it must be something you passed to Qloo as a signal`);
    });
    if (!book) itemProblems.push(`${label}.book_ref: ${bookHandle ?? "(missing)"} is not a ref from any tool result`);
    else if (!ctx.store.isBook(book) || !book.appearances.some((a) => a.role === "result")) {
      itemProblems.push(`${label}.book_ref: ${book.handle} (${book.name}) is not a book that Qloo returned in a result`);
    }
    const why = checkText(`${label}.why`, o?.["why"], LIMITS.why, ctx);
    if (!why.ok) itemProblems.push(...why.problems);

    const cites: Cite[] = [];
    let reduced = false;
    if (!itemProblems.length && book) {
      for (const l of loved as EntityRecord[]) {
        const support = ctx.store.supportingCalls(l, book);
        if (!support.length) itemProblems.push(`${label}: no Qloo result links ${l.handle} to ${book.handle}; only pair a signal with a book returned by a call that used that signal`);
        for (const s of support.slice(0, 2)) {
          if (!cites.some((c) => c.callId === s.call.callId)) cites.push(citeFor(s.call, book));
          reduced ||= isReduced(s.call);
        }
      }
    }
    if (!itemProblems.length && book && why.ok) {
      const key = `${(loved as EntityRecord[]).map((l) => l.handle).sort().join("+")}>${book.handle}`;
      if (seenPairs.has(key)) return;
      seenPairs.add(key);
      cards.push({ id: `b${cards.length + 1}`, loved: (loved as EntityRecord[]).map(toRef), book: toRef(book), why: why.text, cites, reduced });
    } else {
      problems.push(...itemProblems);
      withheld += 1;
    }
  });
  if (shelf.length > LIMITS.maxCards) problems.push(`bridge_shelf: at most ${LIMITS.maxCards} cards`);

  // ---- buy list
  const buy: BuyItem[] = [];
  const seenBooks = new Set<string>();
  const buyRaw = Array.isArray(sub["buy_list"]) ? (sub["buy_list"] as unknown[]) : [];
  if (!Array.isArray(sub["buy_list"])) problems.push("buy_list: must be an array");
  const wanted = Math.max(1, ctx.form.titleCount);
  buyRaw.forEach((item, i) => {
    const label = `buy_list[${i}]`;
    const o = asRec(item);
    const itemProblems: string[] = [];
    const bookHandle = typeof o?.["book_ref"] === "string" ? (o["book_ref"] as string) : undefined;
    const book = bookHandle ? lookup(bookHandle, ctx) : undefined;
    if (!book) itemProblems.push(`${label}.book_ref: ${bookHandle ?? "(missing)"} is not a ref from any tool result`);
    else if (!ctx.store.isBook(book) || !book.appearances.some((a) => a.role === "result")) {
      itemProblems.push(`${label}.book_ref: ${book.handle} (${book.name}) is not a book that Qloo returned in a result`);
    }
    const rationale = checkText(`${label}.rationale`, o?.["rationale"], LIMITS.rationale, ctx);
    if (!rationale.ok) itemProblems.push(...rationale.problems);
    if (!itemProblems.length && book && rationale.ok) {
      if (seenBooks.has(book.handle) || buy.length >= wanted) return;
      seenBooks.add(book.handle);
      const { evidence, cites } = buyEvidence(ctx.store, book);
      buy.push({ rank: buy.length + 1, book: toRef(book), rationale: rationale.text, evidence, cites });
    } else {
      problems.push(...itemProblems);
      withheld += 1;
    }
  });

  // ---- programmes
  const programmes: ProgrammeIdea[] = [];
  const progRaw = Array.isArray(sub["programmes"]) ? (sub["programmes"] as unknown[]) : [];
  if (!Array.isArray(sub["programmes"])) problems.push("programmes: must be an array");
  progRaw.slice(0, LIMITS.maxProgrammes).forEach((item, i) => {
    const label = `programmes[${i}]`;
    const o = asRec(item);
    const itemProblems: string[] = [];
    const kind = KINDS.includes(o?.["kind"] as ProgrammeKind) ? (o?.["kind"] as ProgrammeKind) : undefined;
    if (!kind) itemProblems.push(`${label}.kind: must be one of ${KINDS.join(", ")}`);
    const title = checkText(`${label}.title`, o?.["title"], LIMITS.title, ctx);
    if (!title.ok) itemProblems.push(...title.problems);
    const description = checkText(`${label}.description`, o?.["description"], LIMITS.description, ctx);
    if (!description.ok) itemProblems.push(...description.problems);
    const bookHandles = strings(o?.["book_refs"]) ?? [];
    const signalHandles = strings(o?.["signal_refs"]) ?? [];
    const books = bookHandles.map((h) => lookup(h, ctx));
    const signals = signalHandles.map((h) => lookup(h, ctx));
    books.forEach((b, k) => {
      if (!b || !ctx.store.isBook(b) || !b.appearances.some((a) => a.role === "result")) itemProblems.push(`${label}.book_refs[${k}]: ${bookHandles[k]} is not a book that Qloo returned`);
    });
    signals.forEach((s, k) => {
      if (!s || !ctx.store.isInput(s)) itemProblems.push(`${label}.signal_refs[${k}]: ${signalHandles[k]} is not something you passed to Qloo as a signal`);
    });
    if (bookHandles.length + signalHandles.length === 0) itemProblems.push(`${label}: tie the idea to at least one book_ref or signal_ref from the evidence`);
    if (!itemProblems.length && kind && title.ok && description.ok) {
      const cites: Cite[] = [];
      for (const b of books as EntityRecord[]) {
        const call = ctx.store.allCalls().find((c) => b.appearances.some((a) => a.callId === c.callId && a.role === "result") && c.status !== "error");
        if (call && !cites.some((c) => c.callId === call.callId)) cites.push(citeFor(call, b));
      }
      for (const s of signals as EntityRecord[]) {
        const call = ctx.store.allCalls().find((c) => c.resolved.some((r) => r.entity.handle === s.handle) && c.status !== "error");
        if (call && !cites.some((c) => c.callId === call.callId)) cites.push({ callId: call.callId, tool: call.tool, label: `${call.tool.replace(/^qloo_/, "")}: resolved ${s.name}` });
      }
      programmes.push({
        id: `p${programmes.length + 1}`,
        kind,
        title: title.text,
        description: description.text,
        books: (books as EntityRecord[]).map(toRef),
        signals: (signals as EntityRecord[]).map(toRef),
        cites,
      });
    } else {
      problems.push(...itemProblems);
      withheld += 1;
    }
  });

  // ---- notes and assembly
  const notes: ReportNote[] = [];
  const audience = audienceLabel(ctx.form, queriedAudience(ctx.store));
  if (audience.band?.note) notes.push({ kind: "gap", text: audience.band.note });
  if (audience.formNotApplied) {
    notes.push({ kind: "gap", text: "The age focus chosen in the form was not sent to Qloo in this run, so these results are for the whole community." });
  }
  if (cards.some((c) => c.reduced) || buy.some((b) => b.evidence.reduced)) {
    notes.push({ kind: "reduced", text: "Some Qloo calls behind this report returned partial or degraded results. Those items are marked as reduced confidence." });
  }
  if (withheld > 0) {
    notes.push({ kind: "guard", text: `${withheld} suggestion${withheld === 1 ? " was" : "s were"} withheld because ${withheld === 1 ? "it" : "they"} could not be traced to a Qloo result.` });
  }
  const complete = cards.length > 0 && buy.length > 0 && programmes.length > 0;
  if (cards.length === 0) problems.push("bridge_shelf: no valid cards; submit at least one supported pairing");
  if (buy.length === 0) problems.push("buy_list: no valid items; submit at least one book returned by Qloo");
  if (programmes.length === 0) problems.push("programmes: no valid ideas; submit at least one");

  const bn = budgetNote(ctx.form);
  const report: Report = {
    version: ctx.version,
    createdAt: ctx.now.toISOString(),
    sample: ctx.sample,
    place: ctx.form.place,
    audience: audience.label,
    bridgeShelf: cards,
    buyList: buy,
    programmes,
    notes,
    ...(bn ? { budgetNote: bn } : {}),
  };
  return { report, problems, withheld, complete };
}

/** The `submit_report` argument may arrive as an object, a JSON string, or JSON embedded in prose. */
export function extractJsonObject(text: string): unknown {
  const trimmed = text.trim();
  try {
    return JSON.parse(trimmed);
  } catch {
    /* continue */
  }
  const fenced = trimmed.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fenced?.[1]) {
    try {
      return JSON.parse(fenced[1]);
    } catch {
      /* continue */
    }
  }
  // Prose can contain braces before the object (the prompt asks for {eN} placeholders), so try each "{" as a start.
  for (let start = trimmed.indexOf("{"); start !== -1; start = trimmed.indexOf("{", start + 1)) {
    const end = balancedEnd(trimmed, start);
    if (end === -1) continue;
    try {
      const parsed: unknown = JSON.parse(trimmed.slice(start, end + 1));
      if (parsed !== null && typeof parsed === "object") return parsed;
    } catch {
      /* not JSON; try the next "{" */
    }
  }
  return undefined;
}

/** Index of the "}" that closes the "{" at `start`, skipping braces inside strings; -1 if unbalanced. */
function balancedEnd(text: string, start: number): number {
  let depth = 0;
  let inString = false;
  for (let i = start; i < text.length; i++) {
    const ch = text[i];
    if (inString) {
      if (ch === "\\") i += 1;
      else if (ch === '"') inString = false;
    } else if (ch === '"') inString = true;
    else if (ch === "{") depth += 1;
    else if (ch === "}") {
      depth -= 1;
      if (depth === 0) return i;
    }
  }
  return -1;
}
