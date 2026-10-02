// A relative path, not the @shared alias: this is a value import, and the web unit tests run in plain Node.
import { containsContactDetails } from "../../../src/shared/personal-data";
import type { AgeBandId, FormInput } from "@shared/types";

export const MAX_INTERESTS = 600;
export const MAX_PLACE = 120;
export const MIN_TITLES = 3;
export const MAX_TITLES = 20;
export const DEFAULT_TITLES = 8;

/** The form as typed: numbers stay strings so half-typed values are not lost. */
export interface FormValues {
  place: string;
  ageBand: AgeBandId;
  interests: string;
  titleCount: string;
  budget: string;
  avgPrice: string;
}

export const EMPTY_FORM: FormValues = {
  place: "",
  ageBand: "any",
  interests: "",
  titleCount: String(DEFAULT_TITLES),
  budget: "",
  avgPrice: "",
};

export function valuesFromInput(input: FormInput): FormValues {
  return {
    place: input.place,
    ageBand: input.ageBand,
    interests: input.interests,
    titleCount: String(input.titleCount),
    budget: input.budget === undefined ? "" : String(input.budget),
    avgPrice: input.avgPrice === undefined ? "" : String(input.avgPrice),
  };
}

export type FieldName = "place" | "interests" | "titleCount";
export type FormErrors = Partial<Record<FieldName, string>>;

/** Same detector as the server (src/shared/personal-data.ts), so the form and the API never disagree. */
export { containsContactDetails };

const CONTACT_MESSAGE =
  "That looks like an email address or phone number. Shelfwise works from community-level tastes, so please remove personal details.";

function parsePositive(text: string): number | null {
  const trimmed = text.trim();
  if (trimmed === "") return null;
  const value = Number(trimmed);
  return Number.isFinite(value) && value > 0 ? value : null;
}

export interface Validation {
  errors: FormErrors;
  /** Present only when there are no errors. */
  input: FormInput | null;
}

export function validateForm(values: FormValues): Validation {
  const errors: FormErrors = {};
  const place = values.place.trim();
  const interests = values.interests.trim();

  if (place === "") errors.place = "Enter a city or region, such as “Newark, NJ”.";
  else if (place.length > MAX_PLACE) errors.place = `Keep the place under ${MAX_PLACE} characters.`;
  else if (containsContactDetails(place)) errors.place = CONTACT_MESSAGE;

  if (interests === "") errors.interests = "Add at least one thing patrons are into: a show, an artist, a game or a book.";
  else if (interests.length > MAX_INTERESTS)
    errors.interests = `Please keep this under ${MAX_INTERESTS} characters (it is ${interests.length} now).`;
  else if (containsContactDetails(interests)) errors.interests = CONTACT_MESSAGE;

  const count = Number(values.titleCount);
  if (values.titleCount.trim() === "" || !Number.isInteger(count) || count < MIN_TITLES || count > MAX_TITLES) {
    errors.titleCount = `Choose a whole number from ${MIN_TITLES} to ${MAX_TITLES}.`;
  }

  if (Object.keys(errors).length > 0) return { errors, input: null };

  const input: FormInput = { place, ageBand: values.ageBand, interests, titleCount: count };
  const budget = parsePositive(values.budget);
  const avgPrice = parsePositive(values.avgPrice);
  if (budget !== null && avgPrice !== null) {
    input.budget = budget;
    input.avgPrice = avgPrice;
  }
  return { errors, input };
}

export interface BudgetMath {
  budget: number;
  avgPrice: number;
  /** Whole titles the budget covers (rounded down). */
  titles: number;
  exact: boolean;
  /** `titles` limited to the allowed range. */
  clamped: number;
}

/** The arithmetic behind "Work it out from a budget". Null until both numbers are positive. */
export function budgetMath(budgetText: string, priceText: string): BudgetMath | null {
  const budget = parsePositive(budgetText);
  const avgPrice = parsePositive(priceText);
  if (budget === null || avgPrice === null) return null;
  const ratio = budget / avgPrice;
  const titles = Math.floor(ratio);
  return {
    budget,
    avgPrice,
    titles,
    exact: Number.isInteger(ratio),
    clamped: Math.min(MAX_TITLES, Math.max(MIN_TITLES, titles)),
  };
}
