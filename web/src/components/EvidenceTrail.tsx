import { useRef, type KeyboardEvent } from "react";
import type { CallEntry, Turn } from "../lib/reduce";
import { plural } from "../lib/format";
import type { TrailController } from "../hooks/useTrailController";
import { Icon } from "./Icon";
import { TrailRow } from "./TrailRow";

interface EvidenceTrailProps {
  calls: CallEntry[];
  turns: Turn[];
  controller: TrailController;
  /** The run is still streaming. */
  live: boolean;
  /** Below the desktop breakpoint the trail is a bottom sheet instead of a side column. */
  sheet: boolean;
}

interface TurnGroup {
  turn: number;
  label: string;
  entries: CallEntry[];
}

function groupByTurn(calls: CallEntry[], turns: Turn[]): TurnGroup[] {
  const groups: TurnGroup[] = [];
  for (const entry of calls) {
    const last = groups[groups.length - 1];
    if (last && last.turn === entry.turn) last.entries.push(entry);
    else groups.push({ turn: entry.turn, label: turns[entry.turn]?.label ?? "Follow-up", entries: [entry] });
  }
  return groups;
}

export function EvidenceTrail({ calls, turns, controller, live, sheet }: EvidenceTrailProps) {
  const { sheetOpen, toggleSheet, closeSheet, expanded, toggle, highlighted } = controller;
  const handle = useRef<HTMLButtonElement>(null);
  const groups = groupByTurn(calls, turns);
  const showTurnHeadings = groups.length > 1;
  const cached = calls.filter((c) => c.result?.cached).length;
  const count = `${calls.length} ${plural(calls.length, "call")}`;
  const countLine = cached > 0 ? `${count} · ${cached} cached` : count;
  const closed = sheet && !sheetOpen;

  const onKeyDown = (event: KeyboardEvent) => {
    if (sheet && sheetOpen && event.key === "Escape") closeSheet(handle.current);
  };

  return (
    <>
      {sheet && sheetOpen && <div className="trail-backdrop" aria-hidden="true" onClick={() => closeSheet(handle.current)} />}
      <aside
        className={`trail${sheet ? " trail--sheet" : ""}${sheet && sheetOpen ? " is-open" : ""}`}
        aria-label="Evidence trail"
        onKeyDown={onKeyDown}
      >
        {sheet && (
          <button
            ref={handle}
            type="button"
            className="trail__handle"
            aria-expanded={sheetOpen}
            aria-controls="trail-panel"
            onClick={toggleSheet}
          >
            <Icon name="trail" />
            <span className="trail__handle-title">Evidence trail</span>
            <span className="badge">{countLine}</span>
            <Icon name="chevron" className="trail__handle-chevron" />
          </button>
        )}
        <div id="trail-panel" className="trail__panel" inert={closed}>
          {!sheet && (
            <div className="trail__head">
              <h2 className="trail__title">Evidence trail</h2>
              <span className="badge">{countLine}</span>
            </div>
          )}
          <p className="trail__intro">Every title, rank and trend in the report points to a call below.</p>
          {calls.length === 0 ? (
            <p className="trail__empty">Tool calls will appear here as the agent checks Qloo.</p>
          ) : (
            <div className="trail__list">
              {groups.map((group) => (
                <section key={group.turn} className="trail__group">
                  {showTurnHeadings && (
                    <h3 className="trail__turn">{group.turn === 0 ? "Initial search" : `Follow-up: ${group.label}`}</h3>
                  )}
                  <ol className="calls">
                    {group.entries.map((entry) => (
                      <TrailRow
                        key={entry.call.callId}
                        entry={entry}
                        expanded={expanded.has(entry.call.callId)}
                        highlighted={highlighted === entry.call.callId}
                        live={live}
                        onToggle={() => toggle(entry.call.callId)}
                      />
                    ))}
                  </ol>
                </section>
              ))}
            </div>
          )}
        </div>
      </aside>
    </>
  );
}
