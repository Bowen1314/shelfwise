/**
 * PLACEHOLDER DATA - NOT QLOO RESULTS.
 *
 * Used only when DEMO_FIXTURES=1 so the UI and agent can be developed without API keys.
 * Titles are real works, chosen so the screens look realistic. Every relationship between a signal and a
 * book, every affinity, trend and heatmap value below is INVENTED for development. Nothing here is a claim
 * about any audience, place or book. Phase 2 replaces this with recorded real runs.
 *
 * Every envelope built from this data carries `fixture: true` and the SAMPLE_DATA_LABEL.
 */

export interface SampleSignal {
  key: string;
  id: string;
  name: string;
  type: "tv_show" | "movie" | "artist" | "videogame" | "podcast" | "book";
  year?: number;
}

export interface SampleBook {
  slug: string;
  name: string;
  year: number;
  tags: string[];
  translated?: boolean;
  ya?: boolean;
  trend: "rising" | "fading" | "steady" | "none";
  /** signal key -> placeholder affinity */
  aff: Record<string, number>;
}

export const SAMPLE_SIGNALS: SampleSignal[] = [
  { key: "sev", id: "sample-sig-severance", name: "Severance", type: "tv_show", year: 2022 },
  { key: "bear", id: "sample-sig-the-bear", name: "The Bear", type: "tv_show", year: 2022 },
  { key: "bridg", id: "sample-sig-bridgerton", name: "Bridgerton", type: "tv_show", year: 2020 },
  { key: "st", id: "sample-sig-stranger-things", name: "Stranger Things", type: "tv_show", year: 2016 },
  { key: "omitb", id: "sample-sig-only-murders", name: "Only Murders in the Building", type: "tv_show", year: 2021 },
  { key: "tswift", id: "sample-sig-taylor-swift", name: "Taylor Swift", type: "artist" },
  { key: "phoebe", id: "sample-sig-phoebe-bridgers", name: "Phoebe Bridgers", type: "artist" },
  { key: "hades", id: "sample-sig-hades", name: "Hades", type: "videogame", year: 2020 },
  { key: "stardew", id: "sample-sig-stardew-valley", name: "Stardew Valley", type: "videogame", year: 2016 },
  { key: "serial", id: "sample-sig-serial", name: "Serial", type: "podcast", year: 2014 },
  { key: "knives", id: "sample-sig-knives-out", name: "Knives Out", type: "movie", year: 2019 },
  // Three different things called "Dune": used to exercise the needs_input (ambiguity) flow.
  { key: "dunebk", id: "sample-sig-dune-book", name: "Dune", type: "book", year: 1965 },
  { key: "dunefilm", id: "sample-sig-dune-film", name: "Dune", type: "movie", year: 2021 },
  { key: "duneproph", id: "sample-sig-dune-prophecy", name: "Dune: Prophecy", type: "tv_show", year: 2024 },
];

const b = (slug: string, name: string, year: number, tags: string[], trend: SampleBook["trend"], aff: Record<string, number>, flags: Partial<SampleBook> = {}): SampleBook => ({
  slug,
  name,
  year,
  tags,
  trend,
  aff,
  ...flags,
});

export const SAMPLE_BOOKS: SampleBook[] = [
  b("station-eleven", "Station Eleven", 2014, ["post-apocalyptic", "literary fiction", "science fiction"], "steady", { sev: 0.88, phoebe: 0.74, st: 0.61, dunefilm: 0.52, dunebk: 0.6, hades: 0.4 }),
  b("piranesi", "Piranesi", 2020, ["fantasy", "mystery", "literary fiction"], "rising", { sev: 0.84, hades: 0.71, omitb: 0.55, stardew: 0.6 }),
  b("dark-matter", "Dark Matter", 2016, ["science fiction", "thriller"], "steady", { sev: 0.81, st: 0.77, dunefilm: 0.58, dunebk: 0.55 }),
  b("recursion", "Recursion", 2019, ["science fiction", "thriller"], "fading", { sev: 0.79, st: 0.73 }),
  b("the-memory-police", "The Memory Police", 1994, ["translated fiction", "science fiction", "literary fiction"], "rising", { sev: 0.72, phoebe: 0.55 }, { translated: true }),
  b("convenience-store-woman", "Convenience Store Woman", 2016, ["translated fiction", "literary fiction"], "steady", { sev: 0.68, bear: 0.62 }, { translated: true }),
  b("klara-and-the-sun", "Klara and the Sun", 2021, ["science fiction", "literary fiction"], "none", { sev: 0.7, phoebe: 0.58 }),
  b("project-hail-mary", "Project Hail Mary", 2021, ["science fiction"], "steady", { sev: 0.55, dunefilm: 0.83, dunebk: 0.81, st: 0.6, stardew: 0.5 }),
  b("tomorrow-x3", "Tomorrow, and Tomorrow, and Tomorrow", 2022, ["literary fiction"], "rising", { hades: 0.78, stardew: 0.74, bear: 0.55, tswift: 0.45 }),
  b("crying-in-h-mart", "Crying in H Mart", 2021, ["memoir"], "steady", { bear: 0.86, phoebe: 0.66, tswift: 0.5 }),
  b("kitchen-confidential", "Kitchen Confidential", 2000, ["memoir"], "fading", { bear: 0.82 }),
  b("kitchen", "Kitchen", 1988, ["translated fiction", "literary fiction"], "none", { bear: 0.64 }, { translated: true }),
  b("thursday-murder-club", "The Thursday Murder Club", 2020, ["cozy mystery", "mystery"], "steady", { omitb: 0.9, knives: 0.86, serial: 0.55 }),
  b("magpie-murders", "Magpie Murders", 2016, ["mystery"], "steady", { knives: 0.84, omitb: 0.78 }),
  b("in-the-woods", "In the Woods", 2007, ["mystery", "thriller"], "fading", { serial: 0.79, knives: 0.6, omitb: 0.55 }),
  b("the-silent-patient", "The Silent Patient", 2019, ["thriller", "mystery"], "fading", { serial: 0.74, knives: 0.58 }),
  b("evelyn-hugo", "The Seven Husbands of Evelyn Hugo", 2017, ["romance", "historical fiction"], "rising", { bridg: 0.85, tswift: 0.78 }),
  b("daisy-jones", "Daisy Jones & The Six", 2019, ["historical fiction", "romance"], "steady", { tswift: 0.8, phoebe: 0.72, bridg: 0.56 }),
  b("song-of-achilles", "The Song of Achilles", 2011, ["historical fiction", "fantasy", "romance"], "rising", { hades: 0.8, bridg: 0.62, tswift: 0.4 }),
  b("circe", "Circe", 2018, ["fantasy", "historical fiction"], "steady", { hades: 0.84, stardew: 0.45, bridg: 0.5 }),
  b("acotar", "A Court of Thorns and Roses", 2015, ["fantasy", "romance"], "steady", { bridg: 0.78, hades: 0.52 }, { ya: true }),
  b("cruel-prince", "The Cruel Prince", 2018, ["fantasy", "young adult"], "steady", { bridg: 0.6, st: 0.63 }, { ya: true }),
  b("hunger-games", "The Hunger Games", 2008, ["young adult", "science fiction"], "steady", { st: 0.81, hades: 0.46 }, { ya: true }),
  b("six-of-crows", "Six of Crows", 2015, ["young adult", "fantasy"], "rising", { st: 0.7, hades: 0.66 }, { ya: true }),
  b("legendborn", "Legendborn", 2020, ["young adult", "fantasy"], "rising", { st: 0.64 }, { ya: true }),
  b("we-were-liars", "We Were Liars", 2014, ["young adult", "mystery"], "fading", { tswift: 0.6, serial: 0.5 }, { ya: true }),
  b("the-vegetarian", "The Vegetarian", 2007, ["translated fiction"], "none", { sev: 0.52, phoebe: 0.5 }, { translated: true }),
  b("fourth-wing", "Fourth Wing", 2023, ["fantasy", "romance"], "rising", { bridg: 0.66, st: 0.5, hades: 0.55 }, { ya: true }),
];

export const SAMPLE_TAGS = [
  "translated fiction",
  "literary fiction",
  "science fiction",
  "fantasy",
  "mystery",
  "cozy mystery",
  "thriller",
  "romance",
  "historical fiction",
  "young adult",
  "memoir",
  "post-apocalyptic",
];

/** Placeholder place model: only these two have local variation; any other place is flagged `partial`. */
export const SAMPLE_PLACES: Record<string, { name: string; lat: number; lon: number; boost: Record<string, number> }> = {
  "newark nj": { name: "Newark, NJ", lat: 40.7357, lon: -74.1724, boost: { "convenience-store-woman": 0.04, "crying-in-h-mart": 0.03 } },
  "austin tx": { name: "Austin, TX", lat: 30.2672, lon: -97.7431, boost: { piranesi: 0.04, "tomorrow-x3": 0.03 } },
};

export const SAMPLE_INPUTS = [
  { place: "Newark, NJ", ageBand: "any", interests: "Severance, The Bear, Phoebe Bridgers", titleCount: 8 },
  { place: "Austin, TX", ageBand: "teens", interests: "Stranger Things, Hades, Taylor Swift", titleCount: 6 },
  { place: "Newark, NJ", ageBand: "any", interests: "Dune, Only Murders in the Building", titleCount: 6 },
] as const;
