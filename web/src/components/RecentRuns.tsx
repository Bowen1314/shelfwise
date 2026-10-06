import { Component, useMemo, useState, type ErrorInfo, type ReactNode, type RefObject } from "react";
import { useNow } from "../hooks/useNow";
import { useTrailController } from "../hooks/useTrailController";
import { plural } from "../lib/format";
import { MAX_RECENT_RUNS, relativeTime, trailCalls, type RecentRun } from "../lib/recentRuns";
import { SampleChip } from "./Chips";
import { EvidenceTrail } from "./EvidenceTrail";
import { Icon } from "./Icon";
import { Results, type TabId } from "./Results";
import { TrailContext } from "./TrailContext";

/** Keeps one unreadable saved run from taking the page down with it. */
class SavedRunBoundary extends Component<{ fallback: ReactNode; children: ReactNode }, { failed: boolean }> {
  override state = { failed: false };

  static getDerivedStateFromError(): { failed: boolean } {
    return { failed: true };
  }

  override componentDidCatch(error: Error, info: ErrorInfo): void {
    console.error("Shelfwise could not show a saved run", error, info.componentStack);
  }

  override render(): ReactNode {
    return this.state.failed ? this.props.fallback : this.props.children;
  }
}

function titlesLine(run: RecentRun): string {
  return `${run.titleCount} ${plural(run.titleCount, "title")}`;
}

interface SavedRunProps {
  run: RecentRun;
  sheet: boolean;
  headingRef: RefObject<HTMLHeadingElement | null>;
  onBack: () => void;
  onPrint: () => void;
  onRemove: () => void;
}

/** A saved report, reopened read-only: same report and evidence trail, no agent, no follow-up box. */
function SavedRun({ run, sheet, headingRef, onBack, onPrint, onRemove }: SavedRunProps) {
  const now = useNow();
  const [tab, setTab] = useState<TabId>("bridge");
  const calls = useMemo(() => trailCalls(run), [run]);
  const known = useMemo(() => new Set(calls.map((entry) => entry.call.callId)), [calls]);
  const trail = useTrailController(known);

  return (
    <TrailContext.Provider value={trail.api}>
      <div className={`shell shell--run work-stage work-stage--run${sheet ? " shell--has-sheet" : ""}`}>
        <main className="run-main">
          <section className="request saved-run" aria-label="Saved run">
            <div className="request__text">
              <p className="request__line">
                <strong>{run.place}</strong>
                <span aria-hidden="true"> · </span>
                <span>{run.audience}</span>
                <span aria-hidden="true"> · </span>
                <span>{titlesLine(run)}</span>
              </p>
              {run.interests && <p className="request__interests">{run.interests}</p>}
            </div>
            <div className="saved-run__actions">
              <button type="button" className="btn btn--secondary btn--small" onClick={onBack}>
                <Icon name="arrow-right" className="icon--flip" />
                All recent runs
              </button>
              <button type="button" className="btn btn--secondary btn--small" onClick={onPrint}>
                <Icon name="printer" />
                Print desk
              </button>
            </div>
          </section>
          <p className="saved-run__note">
            <Icon name="clock" />
            <span>
              Saved {relativeTime(run.savedAt, now)}. This is a read-only copy kept in this browser; start a new search to make changes.
            </span>
          </p>
          <SavedRunBoundary
            fallback={
              <div className="notice notice--error" role="alert">
                <Icon name="alert" />
                <div>
                  <p className="notice__title">This saved run can’t be shown</p>
                  <p>It may have been saved by an older version of Shelfwise.</p>
                  <div className="notice__actions">
                    <button type="button" className="btn btn--secondary btn--small" onClick={onRemove}>
                      <Icon name="trash" />
                      Remove it
                    </button>
                  </div>
                </div>
              </div>
            }
          >
            <Results report={run.report} tab={tab} onTab={setTab} updating={false} headingRef={headingRef} />
          </SavedRunBoundary>
        </main>
        <EvidenceTrail calls={calls} turns={run.turns} controller={trail} live={false} sheet={sheet} />
      </div>
    </TrailContext.Provider>
  );
}

interface RecentRunsProps {
  runs: RecentRun[];
  /** The run opened read-only, or null for the list. */
  opened: RecentRun | null;
  sheet: boolean;
  headingRef: RefObject<HTMLHeadingElement | null>;
  onOpen: (sessionId: string | null) => void;
  onPrint: (sessionId: string) => void;
  onRemove: (sessionId: string) => void;
  onClear: () => void;
  onBuild: () => void;
}

export function RecentRuns({ runs, opened, sheet, headingRef, onOpen, onPrint, onRemove, onClear, onBuild }: RecentRunsProps) {
  const now = useNow();

  if (opened) {
    return (
      <SavedRun
        key={opened.sessionId}
        run={opened}
        sheet={sheet}
        headingRef={headingRef}
        onBack={() => onOpen(null)}
        onPrint={() => onPrint(opened.sessionId)}
        onRemove={() => onRemove(opened.sessionId)}
      />
    );
  }

  // The button that had focus goes away with its row (or with the whole list), so focus moves to the heading.
  const remove = (sessionId: string) => {
    onRemove(sessionId);
    headingRef.current?.focus();
  };
  const clear = () => {
    onClear();
    headingRef.current?.focus();
  };

  return (
    <main className="shell work-stage work-stage--desk">
      <section className="desk" aria-labelledby="recent-title">
        <header className="desk-head">
          <div className="desk-head__text">
            <p className="desk-head__eyebrow">Saved in this browser</p>
            <h2 id="recent-title" className="desk-head__title" tabIndex={-1} ref={headingRef}>
              Recent runs
            </h2>
            <p className="desk-head__lead">
              The last {MAX_RECENT_RUNS} finished shelves, kept on this device only and never sent to the server. Open one to read it again
              or send it to the Print desk.
            </p>
          </div>
          {runs.length > 0 && (
            <button type="button" className="btn btn--secondary btn--small" onClick={clear}>
              <Icon name="trash" />
              Clear all
            </button>
          )}
        </header>

        {runs.length === 0 ? (
          <div className="empty-note desk-empty">
            <p>No recent runs yet. Finished shelves will appear here.</p>
            <div className="desk-empty__actions">
              <button type="button" className="btn btn--primary btn--small" onClick={onBuild}>
                <Icon name="shelf" />
                Build a shelf
              </button>
            </div>
          </div>
        ) : (
          <ul className="recent-list">
            {runs.map((run) => {
              const when = relativeTime(run.savedAt, now);
              return (
                <li key={run.sessionId} className="recent-item">
                  <button type="button" className="recent-item__open" onClick={() => onOpen(run.sessionId)}>
                    <span className="recent-item__place">
                      <span className="sr-only">Open </span>
                      {run.place}
                      {run.report.sample && <SampleChip />}
                    </span>
                    {run.interests && <span className="recent-item__interests">{run.interests}</span>}
                    <span className="recent-item__meta">
                      <span>{when}</span>
                      <span aria-hidden="true"> · </span>
                      <span>{titlesLine(run)}</span>
                      <span aria-hidden="true"> · </span>
                      <span>{run.audience}</span>
                    </span>
                  </button>
                  <div className="recent-item__actions">
                    <button
                      type="button"
                      className="btn btn--secondary btn--small"
                      aria-label={`Open ${run.place}, saved ${when}, in the Print desk`}
                      onClick={() => onPrint(run.sessionId)}
                    >
                      <Icon name="printer" />
                      Print desk
                    </button>
                    <button
                      type="button"
                      className="btn btn--ghost btn--small"
                      aria-label={`Remove ${run.place}, saved ${when}`}
                      onClick={() => remove(run.sessionId)}
                    >
                      <Icon name="trash" />
                      Remove
                    </button>
                  </div>
                </li>
              );
            })}
          </ul>
        )}
      </section>
    </main>
  );
}
