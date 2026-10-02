import { useRef, type KeyboardEvent, type Ref } from "react";
import type { Report, ReportNote } from "@shared/types";
import { BridgeShelf } from "./BridgeShelf";
import { BuyList } from "./BuyList";
import { Programmes } from "./Programmes";
import { SampleChip } from "./Chips";
import { Icon, Spinner, type IconName } from "./Icon";

export type TabId = "bridge" | "buy" | "programmes";

export const TAB_IDS: readonly TabId[] = ["bridge", "buy", "programmes"];

const NEUTRAL_GUARD_TEXT = "Some suggestions were withheld because they could not be traced to a Qloo result.";

const NOTE_META: Record<ReportNote["kind"], { title: string; icon: IconName }> = {
  guard: { title: "Evidence check", icon: "info" },
  reduced: { title: "Reduced confidence", icon: "alert" },
  gap: { title: "Not covered", icon: "info" },
  info: { title: "Note", icon: "info" },
};

function ReportNotes({ notes }: { notes: ReportNote[] }) {
  if (notes.length === 0) return null;
  return (
    <ul className="notes-list" aria-label="Notes about this report">
      {notes.map((note, index) => {
        const meta = NOTE_META[note.kind];
        const detail = note.kind === "guard" && note.text.trim().toLowerCase() === NEUTRAL_GUARD_TEXT.toLowerCase() ? "" : note.text;
        return (
          <li key={`${index}-${note.text}`} className={`report-note report-note--${note.kind}`}>
            <Icon name={meta.icon} />
            <div>
              <p className="report-note__title">{meta.title}</p>
              <p>{note.kind === "guard" ? NEUTRAL_GUARD_TEXT : note.text}</p>
              {note.kind === "guard" && detail && <p className="report-note__detail">{detail}</p>}
            </div>
          </li>
        );
      })}
    </ul>
  );
}

interface ResultsProps {
  report: Report;
  tab: TabId;
  onTab: (tab: TabId) => void;
  /** A follow-up is re-running while this (older) report is on screen. */
  updating: boolean;
  headingRef: Ref<HTMLHeadingElement>;
}

export function Results({ report, tab, onTab, updating, headingRef }: ResultsProps) {
  const tabRefs = useRef<Partial<Record<TabId, HTMLButtonElement | null>>>({});
  const tabs: { id: TabId; label: string; count: number }[] = [
    { id: "bridge", label: "Bridge shelf", count: report.bridgeShelf.length },
    { id: "buy", label: "Buy / feature list", count: report.buyList.length },
    { id: "programmes", label: "Programme ideas", count: report.programmes.length },
  ];

  const onKeyDown = (event: KeyboardEvent) => {
    const index = TAB_IDS.indexOf(tab);
    let next: number | null = null;
    if (event.key === "ArrowRight") next = (index + 1) % TAB_IDS.length;
    else if (event.key === "ArrowLeft") next = (index - 1 + TAB_IDS.length) % TAB_IDS.length;
    else if (event.key === "Home") next = 0;
    else if (event.key === "End") next = TAB_IDS.length - 1;
    if (next === null) return;
    event.preventDefault();
    const id = TAB_IDS[next];
    if (!id) return;
    onTab(id);
    tabRefs.current[id]?.focus();
  };

  return (
    <section className="results" aria-labelledby="results-heading" aria-busy={updating}>
      <header className="results__head">
        <h2 id="results-heading" className="results__title" tabIndex={-1} ref={headingRef}>
          Your shelf for {report.place}
        </h2>
        <p className="results__meta">
          <span>{report.audience}</span>
          <span aria-hidden="true"> · </span>
          <span>Version {report.version}</span>
          {report.sample && <SampleChip />}
          {updating && (
            <span className="results__updating">
              <Spinner />
              Updating…
            </span>
          )}
        </p>
      </header>

      <ReportNotes notes={report.notes} />

      <div className="tabs">
        <div className="tablist" role="tablist" aria-label="Report sections" onKeyDown={onKeyDown}>
          {tabs.map((t) => (
            <button
              key={t.id}
              ref={(node) => {
                tabRefs.current[t.id] = node;
              }}
              type="button"
              role="tab"
              id={`tab-${t.id}`}
              className="tab"
              aria-selected={tab === t.id}
              aria-controls={`panel-${t.id}`}
              tabIndex={tab === t.id ? 0 : -1}
              onClick={() => onTab(t.id)}
            >
              {t.label}
              <span className="tab__count">{t.count}</span>
            </button>
          ))}
        </div>

        <div role="tabpanel" id="panel-bridge" aria-labelledby="tab-bridge" className="tabpanel" hidden={tab !== "bridge"}>
          <BridgeShelf report={report} />
        </div>
        <div role="tabpanel" id="panel-buy" aria-labelledby="tab-buy" className="tabpanel" hidden={tab !== "buy"}>
          <BuyList report={report} />
        </div>
        <div role="tabpanel" id="panel-programmes" aria-labelledby="tab-programmes" className="tabpanel" hidden={tab !== "programmes"}>
          <Programmes ideas={report.programmes} />
        </div>
      </div>
    </section>
  );
}

/** Placeholder shapes shown where the report will appear while the agent is still working. */
export function ResultsSkeleton() {
  return (
    <section className="results results--skeleton" aria-hidden="true">
      <div className="skeleton skeleton--title" />
      <div className="skeleton skeleton--tabs" />
      <div className="skeleton-grid">
        <div className="skeleton skeleton--card" />
        <div className="skeleton skeleton--card" />
        <div className="skeleton skeleton--card" />
        <div className="skeleton skeleton--card" />
      </div>
    </section>
  );
}
