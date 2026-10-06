import { useId, type RefObject } from "react";
import { SAMPLE_DATA_LABEL, type BuyItem, type Cite, type Report } from "@shared/types";
import { useNow } from "../hooks/useNow";
import { entityTitle, plural, PROGRAMME_LABELS, TREND_LABELS } from "../lib/format";
import { relativeTime } from "../lib/recentRuns";
import { PrintShelfTalkers, talkerPageCount } from "./BridgeShelf";
import { SampleChip } from "./Chips";
import { Icon } from "./Icon";
import type { View } from "./SiteChrome";

export type PrintSectionId = "bridge" | "buy" | "programmes";
export type PrintSections = Record<PrintSectionId, boolean>;

/** The desk starts with the shelf-talkers only, which is also all that prints from anywhere outside the desk. */
export const TALKERS_ONLY: PrintSections = { bridge: true, buy: false, programmes: false };

const SECTION_ORDER: readonly PrintSectionId[] = ["bridge", "buy", "programmes"];
const SECTION_NAMES: Record<PrintSectionId, string> = {
  bridge: "Shelf-talker cards",
  buy: "Buy / feature list",
  programmes: "Programme ideas",
};

function sectionCount(report: Report, id: PrintSectionId): number {
  if (id === "bridge") return report.bridgeShelf.length;
  if (id === "buy") return report.buyList.length;
  return report.programmes.length;
}

function evidenceLine(cites: Cite[]): string | null {
  const ids = [...new Set(cites.map((cite) => cite.callId))];
  return ids.length > 0 ? `Evidence: ${ids.join(" · ")}` : null;
}

// ---------------------------------------------------------------------------------------------
// Print-only output
// ---------------------------------------------------------------------------------------------

function PrintDocHead({ report, kicker }: { report: Report; kicker: string }) {
  return (
    <header className="print-doc__head">
      {report.sample && <p className="print-page__sample">{SAMPLE_DATA_LABEL}</p>}
      <p className="print-doc__kicker">{kicker}</p>
      <p className="print-doc__title">{report.place}</p>
      <p className="print-doc__meta">
        {report.audience} · Version {report.version}
      </p>
    </header>
  );
}

function buyFacts(item: BuyItem): string {
  const { matchedSignals, rank, trend, localFit, reduced } = item.evidence;
  return [
    matchedSignals.length > 0 ? `For fans of ${matchedSignals.map((signal) => signal.name).join(", ")}` : null,
    rank ? `Audience rank ${rank.position} of ${rank.of}` : null,
    trend ? `Trend: ${TREND_LABELS[trend.direction].toLowerCase()}` : null,
    localFit ? `Local fit: ${localFit.summary}` : null,
    reduced ? "Reduced confidence" : null,
  ]
    .filter(Boolean)
    .join(" · ");
}

function PrintBuyList({ report }: { report: Report }) {
  return (
    <section className="print-page print-doc">
      <PrintDocHead report={report} kicker="Buy / feature list" />
      {report.budgetNote && <p className="print-doc__note">{report.budgetNote}</p>}
      <ol className="print-list">
        {report.buyList.map((item) => {
          const facts = buyFacts(item);
          const evidence = evidenceLine(item.cites);
          return (
            <li key={item.rank} className="print-item">
              <span className="print-item__rank">{item.rank}</span>
              <div>
                <p className="print-item__title">{entityTitle(item.book)}</p>
                <p className="print-item__text">{item.rationale}</p>
                {facts && <p className="print-item__fine">{facts}</p>}
                {evidence && <p className="print-item__fine">{evidence}</p>}
              </div>
            </li>
          );
        })}
      </ol>
    </section>
  );
}

function PrintProgrammes({ report }: { report: Report }) {
  return (
    <section className="print-page print-doc">
      <PrintDocHead report={report} kicker="Programme ideas" />
      <ol className="print-list">
        {report.programmes.map((idea) => {
          const evidence = evidenceLine(idea.cites);
          return (
            <li key={idea.id} className="print-item print-item--plain">
              <div>
                <p className="print-item__kind">{PROGRAMME_LABELS[idea.kind]}</p>
                <p className="print-item__title">{idea.title}</p>
                <p className="print-item__text">{idea.description}</p>
                {idea.books.length > 0 && (
                  <p className="print-item__fine">Books featured: {idea.books.map((book) => entityTitle(book)).join("; ")}</p>
                )}
                {idea.signals.length > 0 && (
                  <p className="print-item__fine">Built on: {idea.signals.map((signal) => signal.name).join(", ")}</p>
                )}
                {evidence && <p className="print-item__fine">{evidence}</p>}
              </div>
            </li>
          );
        })}
      </ol>
    </section>
  );
}

/**
 * The only print-only area in the app (App mounts exactly one). Hidden on screen; the print stylesheet hides the app
 * and shows this instead. It holds the selected sections and nothing else, so nothing prints twice.
 */
export function PrintArea({ report, sections }: { report: Report | null; sections: PrintSections }) {
  if (!report) return null;
  return (
    <div className="print-sheet" aria-hidden="true">
      {sections.bridge && <PrintShelfTalkers report={report} />}
      {sections.buy && report.buyList.length > 0 && <PrintBuyList report={report} />}
      {sections.programmes && report.programmes.length > 0 && <PrintProgrammes report={report} />}
    </div>
  );
}

// ---------------------------------------------------------------------------------------------
// On-screen desk
// ---------------------------------------------------------------------------------------------

const PREVIEW_ROWS = 4;

function previewLines(report: Report, id: PrintSectionId): string[] {
  if (id === "bridge") return report.bridgeShelf.map((card) => `Try ${entityTitle(card.book)}`);
  if (id === "buy") return report.buyList.map((item) => `${item.rank}. ${entityTitle(item.book)}`);
  return report.programmes.map((idea) => `${PROGRAMME_LABELS[idea.kind]}: ${idea.title}`);
}

function sectionDetail(report: Report, id: PrintSectionId): string {
  const count = sectionCount(report, id);
  if (id === "bridge") {
    if (count === 0) return "No shelf-talkers in this report.";
    const pages = talkerPageCount(report);
    return `${count} ${plural(count, "card")} on ${pages} ${plural(pages, "page")}, six to a page with cut guides.`;
  }
  if (id === "buy") {
    return count === 0 ? "No titles in this report." : `${count} ranked ${plural(count, "title")} with a line of evidence each.`;
  }
  return count === 0 ? "No programme ideas in this report." : `${count} ${plural(count, "idea")}, with the books and signals behind them.`;
}

function PrintOption({
  report,
  id,
  checked,
  onChange,
}: {
  report: Report;
  id: PrintSectionId;
  checked: boolean;
  onChange: (checked: boolean) => void;
}) {
  const uid = useId();
  const count = sectionCount(report, id);
  const lines = previewLines(report, id);
  const more = lines.length - PREVIEW_ROWS;
  return (
    <li className={`print-option${count === 0 ? " print-option--empty" : ""}`}>
      <input
        id={`${uid}-input`}
        type="checkbox"
        className="print-option__check"
        checked={checked && count > 0}
        disabled={count === 0}
        aria-describedby={`${uid}-detail`}
        onChange={(event) => onChange(event.currentTarget.checked)}
      />
      <div className="print-option__body">
        <label htmlFor={`${uid}-input`} className="print-option__title">
          {SECTION_NAMES[id]}
        </label>
        <p id={`${uid}-detail`} className="print-option__detail">
          {sectionDetail(report, id)}
        </p>
        {lines.length > 0 && (
          <ul className="print-option__preview" aria-label={`${SECTION_NAMES[id]} in this report`}>
            {lines.slice(0, PREVIEW_ROWS).map((line, index) => (
              <li key={`${index}-${line}`}>{line}</li>
            ))}
            {more > 0 && <li className="print-option__more">and {more} more</li>}
          </ul>
        )}
      </div>
    </li>
  );
}

interface PrintDeskProps {
  /** The report to print, or null when there is none yet. */
  report: Report | null;
  /** Whether that report is the run on the Build page or one reopened from Recent runs (with its save time). */
  source: { kind: "current" } | { kind: "saved"; savedAt: number } | null;
  /** The run on the Build page has a report, so a saved one can be swapped for it. */
  hasCurrent: boolean;
  /** The run on the Build page is still working on its first report. */
  building: boolean;
  hasRecent: boolean;
  sections: PrintSections;
  onSections: (sections: PrintSections) => void;
  onUseCurrent: () => void;
  onNavigate: (view: View) => void;
  headingRef: RefObject<HTMLHeadingElement | null>;
}

export function PrintDesk({
  report,
  source,
  hasCurrent,
  building,
  hasRecent,
  sections,
  onSections,
  onUseCurrent,
  onNavigate,
  headingRef,
}: PrintDeskProps) {
  const now = useNow();
  const chosen = report ? SECTION_ORDER.filter((id) => sections[id] && sectionCount(report, id) > 0) : [];

  return (
    <main className="shell work-stage work-stage--desk">
      <section className="desk" aria-labelledby="desk-title">
        <header className="desk-head">
          <div className="desk-head__text">
            <p className="desk-head__eyebrow">Printable outputs</p>
            <h2 id="desk-title" className="desk-head__title" tabIndex={-1} ref={headingRef}>
              Print desk
            </h2>
            <p className="desk-head__lead">
              Choose what to print for one shelf. Shelf-talkers print six to a page with cut guides; the lists print black on white.
            </p>
          </div>
        </header>

        {!report || !source ? (
          <div className="empty-note desk-empty">
            <p>
              {building
                ? "Your shelf is still being built. Its cards and lists will be ready to print here when it finishes."
                : "Nothing to print yet. Build a shelf, or reopen one from Recent runs."}
            </p>
            <div className="desk-empty__actions">
              <button type="button" className="btn btn--primary btn--small" onClick={() => onNavigate("build")}>
                <Icon name="shelf" />
                Build a shelf
              </button>
              {hasRecent && (
                <button type="button" className="btn btn--secondary btn--small" onClick={() => onNavigate("recent")}>
                  <Icon name="clock" />
                  Recent runs
                </button>
              )}
            </div>
          </div>
        ) : (
          <>
            <section className="request desk-source" aria-label="Shelf to print">
              <div className="request__text">
                <p className="request__line">
                  <strong>{report.place}</strong>
                  <span aria-hidden="true"> · </span>
                  <span>{report.audience}</span>
                  <span aria-hidden="true"> · </span>
                  <span>Version {report.version}</span>
                  {report.sample && <SampleChip />}
                </p>
                <p className="request__interests">
                  {source.kind === "saved" ? `From Recent runs, saved ${relativeTime(source.savedAt, now)}` : "The shelf on your Build page"}
                </p>
              </div>
              <div className="desk-source__actions">
                {source.kind === "saved" && hasCurrent && (
                  <button
                    type="button"
                    className="btn btn--secondary btn--small"
                    onClick={() => {
                      onUseCurrent();
                      headingRef.current?.focus();
                    }}
                  >
                    Use the current shelf
                  </button>
                )}
                {hasRecent && (
                  <button type="button" className="btn btn--secondary btn--small" onClick={() => onNavigate("recent")}>
                    <Icon name="clock" />
                    Recent runs
                  </button>
                )}
              </div>
            </section>

            <fieldset className="print-options">
              <legend className="print-options__legend">Include in the printout</legend>
              <ul className="print-options__list">
                {SECTION_ORDER.map((id) => (
                  <PrintOption
                    key={id}
                    report={report}
                    id={id}
                    checked={sections[id]}
                    onChange={(checked) => onSections({ ...sections, [id]: checked })}
                  />
                ))}
              </ul>
            </fieldset>

            <div className="desk-actions">
              <button type="button" className="btn btn--primary" onClick={() => window.print()} disabled={chosen.length === 0}>
                <Icon name="printer" />
                Print
              </button>
              <p className="desk-actions__note" aria-live="polite">
                {chosen.length === 0
                  ? "Choose at least one section to print."
                  : `Prints ${chosen.map((id) => SECTION_NAMES[id].toLowerCase()).join(", ")}. Each section starts on a new page.`}
              </p>
            </div>
          </>
        )}
      </section>
    </main>
  );
}
