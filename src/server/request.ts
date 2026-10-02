import { containsContactDetails } from "../shared/personal-data.js";
import { AGE_BANDS, type AgeBandId, type FormInput, type ResolutionChoice, type RunRequest } from "../shared/types.js";

export type Parsed<T> = { ok: true; value: T } | { ok: false; message: string };

// eslint-disable-next-line no-control-regex
const CONTROL = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/;

const fail = (message: string): { ok: false; message: string } => ({ ok: false, message });

/** Safe-use rule: no personal data goes to Qloo or the model. Reject obvious emails and phone numbers. */
export function personalDataProblem(text: string): string | undefined {
  if (containsContactDetails(text)) return "Please remove email addresses and phone numbers. Shelfwise works from what patrons enjoy, not who they are.";
  return undefined;
}

function cleanText(v: unknown, label: string, min: number, max: number): Parsed<string> {
  if (typeof v !== "string") return fail(`${label} is required.`);
  const t = v.replace(/\r\n/g, "\n").trim();
  if (t.length < min) return fail(`${label} is too short.`);
  if (t.length > max) return fail(`${label} is too long (max ${max} characters).`);
  if (CONTROL.test(t)) return fail(`${label} contains characters that are not allowed.`);
  const pii = personalDataProblem(t);
  return pii ? fail(pii) : { ok: true, value: t };
}

function optionalPositive(v: unknown, label: string): Parsed<number | undefined> {
  if (v === undefined || v === null || v === "") return { ok: true, value: undefined };
  if (typeof v !== "number" || !Number.isFinite(v) || v <= 0 || v > 10_000_000) return fail(`${label} must be a positive number.`);
  return { ok: true, value: v };
}

export function parseForm(raw: unknown): Parsed<FormInput> {
  if (!raw || typeof raw !== "object") return fail("The form is missing.");
  const o = raw as Record<string, unknown>;
  const place = cleanText(o["place"], "Place", 2, 80);
  if (!place.ok) return place;
  const interests = cleanText(o["interests"], "What patrons are into", 3, 600);
  if (!interests.ok) return interests;
  const band = o["ageBand"] === undefined ? "any" : typeof o["ageBand"] === "string" ? (AGE_BANDS.find((b) => b.id === o["ageBand"])?.id as AgeBandId | undefined) : undefined;
  if (!band) return fail("Audience is not one of the listed options.");
  const countRaw = o["titleCount"] ?? 8;
  if (typeof countRaw !== "number" || !Number.isInteger(countRaw) || countRaw < 3 || countRaw > 20) return fail("Number of titles must be a whole number from 3 to 20.");
  const budget = optionalPositive(o["budget"], "Budget");
  if (!budget.ok) return budget;
  const avgPrice = optionalPositive(o["avgPrice"], "Average price");
  if (!avgPrice.ok) return avgPrice;
  return {
    ok: true,
    value: {
      place: place.value,
      ageBand: band,
      interests: interests.value,
      titleCount: countRaw,
      ...(budget.value !== undefined ? { budget: budget.value } : {}),
      ...(avgPrice.value !== undefined ? { avgPrice: avgPrice.value } : {}),
    },
  };
}

export function parseRunRequest(body: unknown): Parsed<RunRequest> {
  if (!body || typeof body !== "object") return fail("The request body must be a JSON object.");
  const o = body as Record<string, unknown>;
  const input = o["input"] as Record<string, unknown> | undefined;
  if (!input || typeof input !== "object") return fail("Missing input.");
  const sessionId = typeof o["sessionId"] === "string" && /^[a-f0-9]{32}$/.test(o["sessionId"]) ? o["sessionId"] : undefined;
  if (o["sessionId"] !== undefined && !sessionId) return fail("Unknown session.");

  switch (input["kind"]) {
    case "form": {
      const form = parseForm(input["form"]);
      return form.ok ? { ok: true, value: { input: { kind: "form", form: form.value } } } : form;
    }
    case "message": {
      if (!sessionId) return fail("A follow-up needs a session.");
      const text = cleanText(input["text"], "Message", 1, 500);
      return text.ok ? { ok: true, value: { sessionId, input: { kind: "message", text: text.value } } } : text;
    }
    case "resolution": {
      if (!sessionId) return fail("An answer needs a session.");
      const raw = input["choices"];
      if (!Array.isArray(raw) || raw.length === 0 || raw.length > 20) return fail("Choices are missing.");
      const choices: ResolutionChoice[] = [];
      for (const c of raw) {
        const r = c as { issueId?: unknown; pick?: unknown } | null;
        if (!r || typeof r.issueId !== "string" || r.issueId.length > 40) return fail("A choice is malformed.");
        if (r.pick === null) choices.push({ issueId: r.issueId, pick: null });
        else if (r.pick && typeof r.pick === "object" && typeof (r.pick as { id?: unknown }).id === "string") {
          const p = r.pick as { id: string; name?: unknown };
          // Only the id is trusted; the server looks the candidate up in what it asked about.
          choices.push({ issueId: r.issueId, pick: { id: p.id, name: typeof p.name === "string" ? p.name : "" } });
        } else return fail("A choice is malformed.");
      }
      return { ok: true, value: { sessionId, input: { kind: "resolution", choices } } };
    }
    default:
      return fail("Unknown input kind.");
  }
}
