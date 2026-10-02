/**
 * Development-only scripted backend. Enabled with `?mock=1` on the Vite dev server (see lib/api.ts); the
 * dynamic import sits behind `import.meta.env.DEV`, so none of this ships in a production build.
 *
 * Everything here is placeholder content and says so: health reports mode "fixtures", results carry
 * `sample: true`, entity ids start with "mock-", and affinities are invented numbers for layout purposes.
 *
 * Extra query flags (all optional):
 *   scenario=default | notready | unreachable | ratelimit | busy | error | drop | maxsteps | queue | unmarked
 *   speed=0   play instantly (default 1; 0.5 is twice as fast)
 */
import type {
  AgentEvent,
  BridgeCard,
  BuyItem,
  EntityRef,
  FormInput,
  HealthResponse,
  ProgrammeIdea,
  Report,
  ResolutionIssue,
  RunRequest,
  ToolCallView,
  ToolResultView,
} from "@shared/types";
import { LIMITS_LINE } from "@shared/types";

const params = new URLSearchParams(window.location.search);
const scenario = params.get("scenario") ?? "default";
const speed = Number(params.get("speed") ?? "1");
/** `unmarked` removes the sample marking so layout and print output can be checked as they would look with live data. */
const marked = scenario !== "unmarked";

// ---------------------------------------------------------------------------------------------
// Sample content
// ---------------------------------------------------------------------------------------------

const ent = (handle: string, name: string, type: string, year?: number): EntityRef => ({
  handle,
  entityId: `mock-${handle}`,
  name,
  type,
  year,
});

const SEVERANCE = ent("e1", "Severance", "tv_show", 2022);
const FLEABAG = ent("e2", "Fleabag", "tv_show", 2016);
const BRIDGERS = ent("e3", "Phoebe Bridgers", "artist");
const HADES = ent("e4", "Hades", "video_game", 2020);

const PIRANESI = ent("b1", "Piranesi", "book", 2020);
const EMPLOYEES = ent("b2", "The Employees", "book", 2020);
const KLARA = ent("b3", "Klara and the Sun", "book", 2021);
const NORMAL = ent("b4", "Normal People", "book", 2018);
const CONVENIENCE = ent("b5", "Convenience Store Woman", "book", 2016);
const CIRCE = ent("b6", "Circe", "book", 2018);
const ACHILLES = ent("b7", "The Song of Achilles", "book", 2011);
const TOMORROW = ent("b8", "Tomorrow, and Tomorrow, and Tomorrow", "book", 2022);
const ELEVEN = ent("b9", "Station Eleven", "book", 2014);

const SAMPLE_INPUTS: FormInput[] = [
  { place: "Newark, NJ", ageBand: "teens", interests: "Severance, Fleabag, the game Hades, Phoebe Bridgers", titleCount: 8 },
  { place: "Columbus, OH", ageBand: "35-54", interests: "Succession, The Bear, Taylor Swift, true crime podcasts", titleCount: 10 },
  { place: "Portland, ME", ageBand: "any", interests: "Studio Ghibli films, Hozier, cozy games", titleCount: 6, budget: 400, avgPrice: 18 },
];

function health(): HealthResponse {
  return {
    ok: true,
    mode: marked ? "fixtures" : "live",
    ready: scenario !== "notready",
    problems: scenario === "notready" ? ["QLOO_API_KEY is not set.", "NEBIUS_API_KEY is not set."] : [],
    llm: { provider: "mock", model: "scripted", scripted: true },
    qloo: { sample: marked, mcpUp: null },
    limitsLine: LIMITS_LINE,
    limits: { maxSteps: 14, maxToolCalls: 24, runsPerHour: 6, messagesPerHour: 30, maxConcurrentRuns: 2 },
    sampleInputs: marked ? SAMPLE_INPUTS : [],
  };
}

const call = (callId: string, tool: string, label: string, args: Record<string, unknown>): ToolCallView => ({ callId, tool, label, args });

function result(
  base: Pick<ToolResultView, "callId" | "tool" | "status" | "summary"> & Partial<ToolResultView>,
): ToolResultView {
  return {
    durationMs: 420,
    cached: false,
    sample: marked,
    resolved: [],
    requests: [],
    resultCount: 0,
    preview: [],
    warnings: [],
    raw: { mock: true, note: "Placeholder envelope for layout testing." },
    ...base,
  };
}

const describeIssues: ResolutionIssue[] = [
  {
    issueId: "c1.1",
    input: "Severance",
    kind: "ambiguous",
    inputKind: "entity",
    field: "signals",
    candidates: [
      { id: "mock-sev-tv", name: "Severance", type: "tv_show", releaseYear: 2022, description: "Workplace thriller series about employees whose memories are surgically divided between work and home." },
      { id: "mock-sev-book", name: "Severance", type: "book", releaseYear: 2018, description: "Novel about a New York office worker who keeps going to work as an epidemic empties the city." },
      { id: "mock-sev-film", name: "Severance", type: "movie", releaseYear: 2006, description: "British comedy horror film about a corporate team-building weekend." },
    ],
  },
  { issueId: "c1.2", input: "the game Hades", kind: "not_found", inputKind: "entity", field: "signals", candidates: [] },
];

function resolvedAfterAnswer(): ToolResultView["resolved"] {
  return [
    { input: "Severance", entity: SEVERANCE },
    { input: "Fleabag", entity: FLEABAG },
    { input: "Phoebe Bridgers", entity: BRIDGERS },
  ];
}

function bridgeCards(): BridgeCard[] {
  const mk = (id: string, loved: EntityRef[], book: EntityRef, why: string, cites: string[], reduced = false): BridgeCard => ({
    id,
    loved,
    book,
    why,
    reduced,
    cites: cites.map((callId) => ({ callId, tool: callId === "c6" ? "qloo_rank" : "qloo_recommend", label: "sample citation" })),
  });
  return [
    mk("br1", [SEVERANCE], PIRANESI, "A solitary man keeps careful records of a vast, strange house, and slowly asks who has been keeping him there.", ["c3", "c6"]),
    mk("br2", [SEVERANCE, FLEABAG], EMPLOYEES, "Short, eerie testimony from workers on a spaceship who start to question what the job is doing to them.", ["c3", "c4"]),
    mk("br3", [FLEABAG], NORMAL, "Awkward, funny and exact about how people hurt each other while trying to be close.", ["c4", "c6"], true),
    mk("br4", [BRIDGERS], KLARA, "A quiet, aching narrator watches the people she loves; a good match for listeners who like their sadness gentle.", ["c5"]),
    mk("br5", [SEVERANCE, BRIDGERS], CONVENIENCE, "A slim, deadpan novel about fitting in at work, translated from the Japanese.", ["c3", "c5"]),
    mk("br6", [FLEABAG, BRIDGERS], ELEVEN, "Travelling players keep art alive after the end of the world; tender rather than grim.", ["c4", "c5", "c6"]),
  ];
}

function buyItems(): BuyItem[] {
  const trendOf = (book: EntityRef, direction: "rising" | "fading" | "steady", basis: string) => ({
    callId: "c8",
    entity: book,
    direction,
    basis,
    startDate: "2026-01-01",
    endDate: "2026-09-01",
    points: 9,
  });
  const local = (book: EntityRef) => ({
    callId: "c7",
    entity: book,
    within: "the Newark area",
    areas: 4,
    topAffinity: 0.91,
    summary: "Appears among the popular titles in 4 sample areas near Newark.",
  });
  const rows: { book: EntityRef; why: string; signals: EntityRef[]; pos: number; rank: number; rankAff: number; reduced?: boolean; trend?: "rising" | "fading" | "steady" }[] = [
    { book: PIRANESI, why: "Returned for Severance and ranked first for this audience; a mystery that suits readers who like uncanny institutions.", signals: [SEVERANCE], pos: 1, rank: 1, rankAff: 0.94, trend: "rising" },
    { book: EMPLOYEES, why: "Matches both Severance and Fleabag; short enough to hand to a reluctant reader.", signals: [SEVERANCE, FLEABAG], pos: 2, rank: 2, rankAff: 0.9, trend: "steady" },
    { book: NORMAL, why: "Returned for Fleabag; a safe bet for readers who want to feel understood.", signals: [FLEABAG], pos: 1, rank: 3, rankAff: 0.88, reduced: true, trend: "steady" },
    { book: KLARA, why: "Returned for Phoebe Bridgers; gentle, melancholy and widely held.", signals: [BRIDGERS], pos: 3, rank: 4, rankAff: 0.85, trend: "fading" },
    { book: CONVENIENCE, why: "A translated novel that bridges the workplace theme of Severance with a deadpan tone.", signals: [SEVERANCE, BRIDGERS], pos: 4, rank: 5, rankAff: 0.83, trend: "rising" },
    { book: ELEVEN, why: "Returned for three of your signals, with strong local fit.", signals: [FLEABAG, BRIDGERS], pos: 5, rank: 6, rankAff: 0.8, trend: "steady" },
    { book: CIRCE, why: "Bridges a game audience to myth retellings; checked against local popularity.", signals: [BRIDGERS], pos: 6, rank: 7, rankAff: 0.78, trend: "rising" },
    { book: TOMORROW, why: "A novel about making games together; a natural pick for patrons who play.", signals: [FLEABAG], pos: 7, rank: 8, rankAff: 0.74, trend: "steady" },
  ];
  return rows.map(({ book, why, signals, pos, rank, rankAff, reduced, trend }, index): BuyItem => ({
    rank: index + 1,
    book,
    rationale: why,
    cites: [
      { callId: "c3", tool: "qloo_recommend", label: `result ${pos} of 8` },
      { callId: "c6", tool: "qloo_rank", label: `rank ${rank} of 12` },
    ],
    evidence: {
      matchedSignals: signals,
      recommendations: signals.map((signal, i) => ({
        callId: signal.handle === "e3" ? "c5" : signal.handle === "e2" ? "c4" : "c3",
        signal,
        position: pos + i,
        of: 8,
        affinity: Number((0.9 - (pos + i) * 0.037).toFixed(3)),
      })),
      rank: { callId: "c6", position: rank, of: 12, affinity: rankAff },
      localFit: index < 6 ? local(book) : undefined,
      trend: trend ? trendOf(book, trend, trend === "rising" ? "Search interest in the later months is above the earlier months (sample series)." : trend === "fading" ? "Search interest fell across the series (sample series)." : "No clear change across the series (sample series).") : undefined,
      reduced: reduced ?? false,
    },
  }));
}

function programmeIdeas(): ProgrammeIdea[] {
  return [
    {
      id: "pr1",
      kind: "film_night",
      title: "Severance screening and “Who keeps the house?”",
      description: "Screen two episodes of Severance and pair them with a table of Piranesi, The Employees and Convenience Store Woman. A short discussion prompt asks what each story says about work and identity.",
      books: [PIRANESI, EMPLOYEES, CONVENIENCE],
      signals: [SEVERANCE],
      cites: [{ callId: "c3", tool: "qloo_recommend", label: "sample citation" }],
    },
    {
      id: "pr2",
      kind: "themed_display",
      title: "If you loved Fleabag",
      description: "A face-out display of funny, honest novels about complicated relationships, with the shelf-talkers from this report on each book.",
      books: [NORMAL, ELEVEN],
      signals: [FLEABAG, BRIDGERS],
      cites: [{ callId: "c4", tool: "qloo_recommend", label: "sample citation" }, { callId: "c6", tool: "qloo_rank", label: "sample citation" }],
    },
    {
      id: "pr3",
      kind: "book_club",
      title: "Teen book club: Station Eleven",
      description: "A four-week club that reads Station Eleven in sections, with a playlist chosen from the artists patrons already follow.",
      books: [ELEVEN],
      signals: [BRIDGERS],
      cites: [{ callId: "c5", tool: "qloo_recommend", label: "sample citation" }],
    },
  ];
}

function report(version: number, extra: Partial<Report> = {}): Report {
  return {
    version,
    createdAt: "2026-10-02T12:00:00.000Z",
    sample: marked,
    place: "Newark, NJ",
    audience: "Teens and young adults",
    bridgeShelf: bridgeCards(),
    buyList: buyItems(),
    programmes: programmeIdeas(),
    notes: [
      { kind: "guard", text: "Some suggestions were withheld because they could not be traced to a Qloo result." },
      { kind: "reduced", text: "One recommendation lookup returned partial results, so the matching titles carry reduced confidence." },
      { kind: "gap", text: "The audience comparison returned no results, so nothing here is compared across age groups." },
    ],
    budgetNote: "$400 / $18 per title = 22 titles",
    ...extra,
  };
}

// ---------------------------------------------------------------------------------------------
// Scripts: each step is [delay in ms before it, event]
// ---------------------------------------------------------------------------------------------

type Step = readonly [number, AgentEvent];

const SESSION_ID = "mock-session";

function firstRun(): Step[] {
  return [
    [0, { type: "session", sessionId: SESSION_ID, runId: "mock-run-1", mode: marked ? "fixtures" : "live" }],
    [200, { type: "queued", position: 2, ahead: scenario === "queue" ? 3 : 1 }],
    [scenario === "queue" ? 2500 : 900, { type: "queued", position: 1, ahead: 0 }],
    [900, { type: "started" }],
    [
      300,
      {
        type: "plan",
        steps: [
          { title: "Look up what patrons love", tool: "qloo_describe" },
          { title: "Find books that fans of each signal also pick up", tool: "qloo_recommend" },
          { title: "Rank candidates for this audience", tool: "qloo_rank" },
          { title: "Check local fit", tool: "qloo_where_popular" },
          { title: "Check the direction of interest", tool: "qloo_trends" },
          { title: "Write the shelf, buy list and programme ideas" },
        ],
      },
    ],
    [400, { type: "note", text: "Looking up the shows, artists and games you mentioned." }],
    [300, { type: "tool_call", call: call("c1", "qloo_describe", "Look up “Severance”, “Fleabag”, “the game Hades” and “Phoebe Bridgers”", { entities: ["Severance", "Fleabag", "the game Hades", "Phoebe Bridgers"] }) }],
    [
      900,
      {
        type: "tool_result",
        result: result({
          callId: "c1",
          tool: "qloo_describe",
          status: "needs_input",
          summary: "2 of 4 inputs need a decision: “Severance” matches three entities and “the game Hades” matched nothing.",
          durationMs: 880,
          resolved: [
            { input: "Fleabag", entity: FLEABAG },
            { input: "Phoebe Bridgers", entity: BRIDGERS },
          ],
          requests: [{ path: "/search", query: { query: "Severance", types: "tv_show,book,movie" } }, { path: "/search", query: { query: "Fleabag" } }],
          resultCount: 2,
        }),
      },
    ],
    [
      200,
      { type: "needs_input", callId: "c1", tool: "qloo_describe", message: "“Severance” matches more than one thing, and I couldn’t find “the game Hades”. Tell me which Severance you meant.", issues: describeIssues },
    ],
    [100, { type: "done", reason: "awaiting_input", steps: 1, toolCalls: 1 }],
  ];
}

function afterAnswer(): Step[] {
  const rec = (id: string, signal: EntityRef) => call(id, "qloo_recommend", `Recommend books for fans of ${signal.name} near Newark, NJ`, { signals: [signal.entityId], type: "book", location: "Newark, NJ", demographic: "teens" });
  const books = (rows: [EntityRef, number][]) => rows.map(([book, affinity], i) => ({ handle: book.handle, name: book.name, type: "book", year: book.year, affinity, detail: `result ${i + 1}` }));
  return [
    [0, { type: "session", sessionId: SESSION_ID, runId: "mock-run-2", mode: marked ? "fixtures" : "live" }],
    [200, { type: "started" }],
    [300, { type: "note", text: "Thanks. Using the TV series, and skipping the game I couldn’t find." }],
    [300, { type: "tool_call", call: call("c2", "qloo_describe", "Confirm “Severance” (TV series, 2022)", { entities: ["mock-sev-tv"] }) }],
    [500, { type: "tool_result", result: result({ callId: "c2", tool: "qloo_describe", status: "ok", summary: "Confirmed 3 of 3 signals.", durationMs: 310, resolved: resolvedAfterAnswer(), resultCount: 3 }) }],
    [300, { type: "tool_call", call: rec("c3", SEVERANCE) }],
    [600, { type: "retry", callId: "c3", attempt: 2, delayMs: 800, reason: "Qloo answered 503; waiting before trying again." }],
    [
      1400,
      {
        type: "tool_result",
        result: result({
          callId: "c3",
          tool: "qloo_recommend",
          status: "ok",
          summary: "8 books returned for Severance.",
          durationMs: 1980,
          resolved: [{ input: "Severance", entity: SEVERANCE }],
          requests: [{ path: "/v2/insights", query: { "filter.type": "urn:entity:book", "signal.interests.entities": "mock-e1", "filter.location.query": "Newark, NJ" } }],
          resultCount: 8,
          preview: books([[PIRANESI, 0.913], [EMPLOYEES, 0.877], [CONVENIENCE, 0.841], [ELEVEN, 0.82], [KLARA, 0.79]]),
        }),
      },
    ],
    [200, { type: "note", text: "Fleabag fans lean towards literary fiction; checking that next." }],
    [200, { type: "tool_call", call: rec("c4", FLEABAG) }],
    [
      800,
      {
        type: "tool_result",
        result: result({
          callId: "c4",
          tool: "qloo_recommend",
          status: "partial",
          summary: "5 of 8 requested books returned for Fleabag; the rest were not available.",
          durationMs: 1210,
          resolved: [{ input: "Fleabag", entity: FLEABAG }],
          requests: [{ path: "/v2/insights", query: { "filter.type": "urn:entity:book", "signal.interests.entities": "mock-e2" } }],
          resultCount: 5,
          preview: books([[NORMAL, 0.884], [EMPLOYEES, 0.83], [ELEVEN, 0.79], [TOMORROW, 0.77], [CIRCE, 0.7]]),
          warnings: ["Qloo returned fewer results than requested for this signal."],
        }),
      },
    ],
    [200, { type: "tool_call", call: rec("c5", BRIDGERS) }],
    [
      500,
      {
        type: "tool_result",
        result: result({
          callId: "c5",
          tool: "qloo_recommend",
          status: "ok",
          summary: "8 books returned for Phoebe Bridgers (cached from earlier in this session).",
          durationMs: 4,
          cached: true,
          resolved: [{ input: "Phoebe Bridgers", entity: BRIDGERS }],
          resultCount: 8,
          preview: books([[KLARA, 0.86], [ELEVEN, 0.84], [CONVENIENCE, 0.8], [CIRCE, 0.77]]),
        }),
      },
    ],
    [250, { type: "tool_call", call: call("c6", "qloo_rank", "Rank the candidate books for teens and young adults", { candidates: 12, demographic: "teens" }) }],
    [
      700,
      {
        type: "tool_result",
        result: result({
          callId: "c6",
          tool: "qloo_rank",
          status: "ok",
          summary: "12 candidates ranked for the audience.",
          durationMs: 760,
          resultCount: 12,
          preview: [{ name: PIRANESI.name, type: "book", year: 2020, affinity: 0.94, detail: "rank 1 of 12" }, { name: EMPLOYEES.name, type: "book", year: 2020, affinity: 0.9, detail: "rank 2 of 12" }, { name: NORMAL.name, type: "book", year: 2018, affinity: 0.88, detail: "rank 3 of 12" }],
        }),
      },
    ],
    [250, { type: "tool_call", call: call("c7", "qloo_where_popular", "Check where the top titles are popular around Newark, NJ", { within: "Newark, NJ", entities: 6 }) }],
    [
      600,
      {
        type: "tool_result",
        result: result({
          callId: "c7",
          tool: "qloo_where_popular",
          status: "ok",
          summary: "Local popularity found for 6 titles.",
          durationMs: 640,
          resultCount: 6,
          local: { callId: "c7", entity: PIRANESI, within: "the Newark area", areas: 4, topAffinity: 0.91, summary: "Appears among the popular titles in 4 sample areas near Newark." },
        }),
      },
    ],
    [250, { type: "tool_call", call: call("c8", "qloo_trends", "Check whether interest in the top titles is rising", { entities: 6, window: "2026-01-01/2026-09-01" }) }],
    [
      600,
      {
        type: "tool_result",
        result: result({
          callId: "c8",
          tool: "qloo_trends",
          status: "ok",
          summary: "Trend series returned for 6 titles.",
          durationMs: 910,
          resultCount: 6,
          trend: [{ callId: "c8", entity: PIRANESI, direction: "rising", basis: "Interest in the later months is above the earlier months (sample series).", startDate: "2026-01-01", endDate: "2026-09-01", points: 9 }],
        }),
      },
    ],
    [250, { type: "tool_call", call: call("c9", "qloo_compare_audiences", "Compare the picks across age groups", { demographics: ["teens", "35-54"] }) }],
    [
      500,
      {
        type: "tool_result",
        result: result({
          callId: "c9",
          tool: "qloo_compare_audiences",
          status: "empty",
          summary: "Qloo had no audience comparison for these titles. This does not affect the picks above.",
          durationMs: 540,
          resultCount: 0,
        }),
      },
    ],
    [300, { type: "note", text: "Writing up the shelf-talkers, the ranked list and three programme ideas." }],
    [900, { type: "report", report: report(1) }],
    [150, { type: "done", reason: scenario === "maxsteps" ? "max_steps" : "completed", steps: 9, toolCalls: 9 }],
  ];
}

function followUp(text: string): Step[] {
  const lower = text.toLowerCase();
  if (lower.includes("?")) {
    return [
      [0, { type: "session", sessionId: SESSION_ID, runId: "mock-run-3", mode: marked ? "fixtures" : "live" }],
      [200, { type: "started" }],
      [600, { type: "message", text: "Sample reply: the ranked list is ordered by the audience-rank call, not by popularity. The rank and every score are shown for each title in the Buy / feature list." }],
      [100, { type: "done", reason: "completed", steps: 1, toolCalls: 0 }],
    ];
  }
  const shorter = lower.includes("shorter");
  const film = lower.includes("film");
  const base = report(2);
  const changed: Report = {
    ...base,
    bridgeShelf: shorter ? base.bridgeShelf.slice(0, 4) : base.bridgeShelf,
    buyList: shorter ? base.buyList.slice(0, 5) : base.buyList,
    programmes: film ? base.programmes.filter((p) => p.kind === "film_night") : base.programmes,
    notes: [{ kind: "info", text: `Updated for your request: “${text}”.` }, ...base.notes.slice(1)],
  };
  return [
    [0, { type: "session", sessionId: SESSION_ID, runId: "mock-run-3", mode: marked ? "fixtures" : "live" }],
    [200, { type: "started" }],
    [400, { type: "plan", steps: [{ title: "Re-check Qloo for this change", tool: "qloo_recommend" }, { title: "Update the report" }] }],
    [300, { type: "tool_call", call: call("c10", "qloo_recommend", `Re-run recommendations for: ${text}`, { signals: ["mock-e1"], type: "book", change: text }) }],
    [900, { type: "tool_result", result: result({ callId: "c10", tool: "qloo_recommend", status: "ok", summary: "8 books returned.", durationMs: 700, resultCount: 8, preview: [{ name: PIRANESI.name, type: "book", year: 2020, affinity: 0.9 }] }) }],
    [500, { type: "report", report: changed }],
    [100, { type: "message", text: "Sample reply: I re-checked Qloo and updated the report. The change is reflected on every tab." }],
    [100, { type: "done", reason: "completed", steps: 2, toolCalls: 1 }],
  ];
}

function errorRun(): Step[] {
  const head = firstRun().slice(0, 4);
  return [
    ...head,
    [400, { type: "tool_call", call: call("c1", "qloo_describe", "Look up “Severance”", { entities: ["Severance"] }) }],
    [900, { type: "error", code: "qloo_unavailable", message: "Qloo didn’t answer after several tries, so the agent stopped before building a shelf.", retryable: true }],
    [100, { type: "done", reason: "error", steps: 1, toolCalls: 1 }],
  ];
}

// ---------------------------------------------------------------------------------------------
// Playing a script as an SSE Response
// ---------------------------------------------------------------------------------------------

const encoder = new TextEncoder();

function wire(event: AgentEvent): string {
  return `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`;
}

function sleep(ms: number, signal: AbortSignal | null | undefined): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(new DOMException("Aborted", "AbortError"));
    const timer = setTimeout(resolve, ms * speed);
    signal?.addEventListener(
      "abort",
      () => {
        clearTimeout(timer);
        reject(new DOMException("Aborted", "AbortError"));
      },
      { once: true },
    );
  });
}

function play(steps: Step[], signal: AbortSignal | null | undefined, dropAfter?: string): Response {
  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      try {
        controller.enqueue(encoder.encode(": heartbeat\r\n\r\n"));
        for (const [delay, event] of steps) {
          await sleep(delay, signal);
          const text = wire(event);
          // Cut the larger messages in two, mid-way through the JSON, to exercise chunk boundaries.
          if (event.type === "report" || event.type === "tool_result") {
            const cut = Math.floor(text.length / 2);
            controller.enqueue(encoder.encode(text.slice(0, cut)));
            await sleep(30, signal);
            controller.enqueue(encoder.encode(text.slice(cut)));
          } else {
            controller.enqueue(encoder.encode(text));
          }
          if (dropAfter && event.type === "tool_result" && event.result.callId === dropAfter) {
            controller.close();
            return;
          }
        }
        controller.close();
      } catch (error) {
        controller.error(error);
      }
    },
  });
  return new Response(stream, { status: 200, headers: { "Content-Type": "text/event-stream; charset=utf-8" } });
}

function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
}

function scriptFor(request: RunRequest): Step[] {
  switch (request.input.kind) {
    case "form":
      return scenario === "error" ? errorRun() : firstRun();
    case "resolution":
      return afterAnswer();
    case "message":
      return followUp(request.input.text);
  }
}

/** Drop-in replacement for `fetch` that answers /api/health and /api/runs from the scripts above. */
export const mockFetch: typeof fetch = async (input, init) => {
  const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
  if (url.endsWith("/api/health")) {
    if (scenario === "unreachable") throw new TypeError("mock: server unreachable");
    return json(200, health());
  }
  if (url.endsWith("/api/runs")) {
    const request = JSON.parse(String(init?.body)) as RunRequest;
    if (request.input.kind === "form") {
      if (scenario === "ratelimit") return json(429, { error: { code: "rate_limited", message: "Too many runs.", retryAfterSec: 540 } });
      if (scenario === "busy") return json(503, { error: { code: "busy", message: "The agent is at capacity." } });
    }
    const steps = scriptFor(request);
    // The first request that completes the form flow pauses for input, so the "drop" scenario cuts the follow-up run.
    const drop = scenario === "drop" && request.input.kind === "resolution" ? "c4" : undefined;
    return play(steps, init?.signal, drop);
  }
  return json(404, { error: { code: "not_found", message: "No such mock route." } });
};
