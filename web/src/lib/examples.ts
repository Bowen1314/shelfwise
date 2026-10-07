import type { FormInput } from "@shared/types";

/**
 * One-click example briefs for live mode. Every interest here resolves to exactly one Qloo entity by name (checked
 * against /search on 2026-10-06), so an example runs straight through without a "which one did you mean?" question.
 * Most musicians are left out on purpose: their names also match self-titled albums and person entities.
 */
export const LIVE_EXAMPLES: FormInput[] = [
  { place: "Brooklyn, NY", ageBand: "25-34", interests: "Abbott Elementary, Ted Lasso, Schitt's Creek", titleCount: 8 },
  { place: "Austin, TX", ageBand: "teens", interests: "Stardew Valley, Hollow Knight, Animal Crossing", titleCount: 6 },
  { place: "Columbus, OH", ageBand: "35-54", interests: "Only Murders in the Building, Crime Junkie, The Great British Baking Show", titleCount: 8 },
  { place: "Tulsa, OK", ageBand: "any", interests: "Reservation Dogs, Brooklyn Nine-Nine, Baldur's Gate 3", titleCount: 6 },
];
