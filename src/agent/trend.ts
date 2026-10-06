import type { TrendDirection } from "../shared/types.js";

/**
 * Direction of a Qloo time series, computed by Shelfwise (not by the model).
 *
 * The harness passes the raw trending points through without a documented shape, so this reads them
 * defensively: it needs a date-like field and one numeric metric present on the points. If it cannot
 * find both it reports "unknown" rather than guessing.
 *
 * Method: compare the mean of the metric in the first half of the dated points with the second half.
 * A relative change beyond +/-10% is rising/fading; otherwise steady.
 */
export const TREND_THRESHOLD = 0.1;

const DATE_KEYS = ["date", "day", "week", "month", "period", "timestamp", "time", "start_date", "end_date"];
// Live /v2/trending points are { date, population_percentile, population_rank (a string), population_rank_velocity,
// velocity_fold_change, population_percent_delta }: the percentile is the level to compare; the others are rates.
const METRIC_KEYS = ["population_percentile", "popularity", "trending_score", "trend_score", "score", "value", "count", "affinity"];
/** Never used as the fallback metric: coordinates, ranks, ids, and rates of change (which are not levels). */
const NOT_A_LEVEL = /(^|_)(lat|lon|lng|latitude|longitude)(_|$)|rank|velocity|delta|fold_change|id$/i;
const NESTED_KEYS = ["query", "metrics", "stats"];
const DATE_LIKE = /^\d{4}-\d{2}(-\d{2})?/;

type Rec = Record<string, unknown>;

function asRec(v: unknown): Rec | undefined {
  return v !== null && typeof v === "object" && !Array.isArray(v) ? (v as Rec) : undefined;
}

function flatten(rec: Rec): Rec {
  const out: Rec = { ...rec };
  for (const nk of NESTED_KEYS) {
    const nested = asRec(rec[nk]);
    if (nested) for (const [k, v] of Object.entries(nested)) if (!(k in out)) out[k] = v;
  }
  return out;
}

function fmt(n: number): string {
  return Number.isInteger(n) ? String(n) : String(Number(n.toPrecision(4)));
}

function mean(xs: number[]): number {
  return xs.reduce((a, b) => a + b, 0) / xs.length;
}

export interface SeriesSummary {
  direction: TrendDirection;
  basis: string;
  points: number;
}

export function summarizeSeries(points: unknown[]): SeriesSummary {
  const n = points.length;
  if (n === 0) return { direction: "unknown", basis: "Qloo returned no trend points for this window.", points: 0 };
  const recs = points.map((p) => asRec(p)).filter((r): r is Rec => r !== undefined).map(flatten);

  const dateKey = DATE_KEYS.find((k) => recs.filter((r) => typeof r[k] === "string" && DATE_LIKE.test(r[k] as string)).length >= 3);
  if (!dateKey) {
    return { direction: "unknown", basis: `Qloo returned ${n} points without dates, so a direction cannot be determined.`, points: n };
  }
  const withDate = recs.filter((r) => typeof r[dateKey] === "string" && DATE_LIKE.test(r[dateKey] as string));
  const metricKey =
    METRIC_KEYS.find((k) => withDate.filter((r) => typeof r[k] === "number" && Number.isFinite(r[k])).length >= 3) ??
    Object.keys(withDate[0] ?? {}).find(
      (k) => k !== dateKey && !NOT_A_LEVEL.test(k) && withDate.filter((r) => typeof r[k] === "number" && Number.isFinite(r[k])).length >= 3,
    );
  if (!metricKey) {
    return { direction: "unknown", basis: `Qloo returned ${n} dated points but no numeric metric Shelfwise recognises.`, points: n };
  }
  const series = withDate
    .filter((r) => typeof r[metricKey] === "number" && Number.isFinite(r[metricKey]))
    .map((r) => ({ date: r[dateKey] as string, value: r[metricKey] as number }))
    .sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0));
  const m = series.length;
  const half = Math.floor(m / 2);
  const first = series.slice(0, half === 0 ? 1 : half).map((s) => s.value);
  const second = series.slice(m - (half === 0 ? 1 : half)).map((s) => s.value);
  const m1 = mean(first);
  const m2 = mean(second);
  const change = m1 === 0 ? (m2 > 0 ? Number.POSITIVE_INFINITY : 0) : (m2 - m1) / Math.abs(m1);
  const direction: TrendDirection = change > TREND_THRESHOLD ? "rising" : change < -TREND_THRESHOLD ? "fading" : "steady";
  const basis =
    `Mean ${metricKey} went from ${fmt(m1)} in the first half to ${fmt(m2)} in the second half of ${m} dated points ` +
    `(${series[0]?.date} to ${series[m - 1]?.date}); changes beyond +/-10% count as rising or fading. Computed by Shelfwise from the Qloo series.`;
  return { direction, basis, points: m };
}
