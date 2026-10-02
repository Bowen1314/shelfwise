import { useEffect, useRef, useState } from "react";
import { currentTurnCalls, type RunState } from "../lib/reduce";
import { derivePhases, derivePlan, type PhaseState, type PlanItemState } from "../lib/progress";
import { summarizeWork } from "../lib/format";
import { Icon, Spinner, type IconName } from "./Icon";

const PHASE_ICONS: Record<PhaseState, IconName | "spinner"> = {
  pending: "circle",
  active: "spinner",
  attention: "help",
  done: "check",
  skipped: "dash",
  interrupted: "alert",
};

const PHASE_WORDS: Record<PhaseState, string> = {
  pending: "not started",
  active: "in progress",
  attention: "needs your input",
  done: "done",
  skipped: "not needed",
  interrupted: "stopped before it finished",
};

function PhaseStrip({ state }: { state: RunState }) {
  const phases = derivePhases({
    calls: currentTurnCalls(state),
    status: state.status,
    reported: state.reportTurn === state.turn,
  });
  return (
    <ol className="phases" aria-label="Progress">
      {phases.map((phase) => {
        const icon = PHASE_ICONS[phase.state];
        return (
          <li
            key={phase.id}
            className={`phase phase--${phase.state}`}
            aria-current={phase.state === "active" || phase.state === "attention" ? "step" : undefined}
          >
            {icon === "spinner" ? <Spinner /> : <Icon name={icon} />}
            <span>{phase.label}</span>
            <span className="sr-only">: {PHASE_WORDS[phase.state]}</span>
          </li>
        );
      })}
    </ol>
  );
}

const PLAN_ICONS: Record<PlanItemState, IconName | "spinner"> = {
  done: "check",
  active: "spinner",
  pending: "circle",
};

function PlanChecklist({ state }: { state: RunState }) {
  if (!state.plan || state.plan.length === 0) return null;
  const items = derivePlan(state.plan, currentTurnCalls(state), state.status, state.reportTurn === state.turn);
  return (
    <div className="run-section">
      <h3 className="run-section__title">Plan</h3>
      <ol className="plan">
        {items.map(({ step, state: itemState }, index) => {
          const icon = PLAN_ICONS[itemState];
          return (
            <li key={`${index}-${step.title}`} className={`plan__item plan__item--${itemState}`}>
              {icon === "spinner" ? <Spinner /> : <Icon name={icon} />}
              <span>{step.title}</span>
              <span className="sr-only">{itemState === "done" ? " (done)" : itemState === "active" ? " (in progress)" : ""}</span>
            </li>
          );
        })}
      </ol>
    </div>
  );
}

function statusLine(state: RunState): { text: string; busy: boolean } {
  if (state.status === "awaiting_input") return { text: "Paused: Shelfwise needs your answers to continue.", busy: false };
  if (state.queue) {
    const where = state.queue.position <= 1 ? "you’re next" : `${state.queue.ahead} ahead of you`;
    return { text: `Waiting for a free slot — ${where}`, busy: true };
  }
  if (state.status === "streaming") {
    if (!state.started && state.calls.length === 0) return { text: "Connecting to the agent…", busy: true };
    const running = currentTurnCalls(state).filter((c) => c.result === null);
    const latest = running[running.length - 1];
    if (latest) {
      const retry = latest.retries[latest.retries.length - 1];
      const suffix = retry ? ` (retrying, attempt ${retry.attempt})` : "";
      return { text: `${latest.call.label}${suffix}`, busy: true };
    }
    return { text: "Working on it…", busy: true };
  }
  return { text: summarizeWork(state.done, currentTurnCalls(state)), busy: false };
}

interface RunPanelProps {
  state: RunState;
  onStop: () => void;
}

/** The live "Working" view: status, phase strip, plan checklist and the model's narration. Collapses once a report is ready. */
export function RunPanel({ state, onStop }: RunPanelProps) {
  const [manual, setManual] = useState<boolean | null>(null);
  const anchor = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (state.status === "streaming") setManual(null);
  }, [state.status, state.turn]);

  // A follow-up is sent from the chat at the bottom of the page; bring the progress into view.
  useEffect(() => {
    if (state.turn > 0 && state.status === "streaming") anchor.current?.scrollIntoView({ block: "start", behavior: "smooth" });
  }, [state.turn, state.status]);

  const autoOpen = !(state.status === "finished" && state.report !== null);
  const open = manual ?? autoOpen;
  const { text, busy } = statusLine(state);
  const streaming = state.status === "streaming";
  const calls = currentTurnCalls(state);
  const finishedNote =
    state.done?.reason === "max_steps"
      ? "The agent hit its step limit; here’s what it found so far."
      : state.done?.reason === "aborted"
        ? "You stopped this run. Anything found before then is kept."
        : null;

  const summary = (
    <section className="run-summary" aria-label="Run summary">
      <button type="button" className="run-summary__toggle" aria-expanded={false} onClick={() => setManual(true)}>
        <Icon name={state.done?.reason === "completed" ? "check" : "alert"} className="run-summary__icon" />
        <span className="run-summary__text">{text}</span>
        <span className="run-summary__action">
          Show details
          <Icon name="chevron" />
        </span>
      </button>
      {finishedNote && <p className="run-summary__note">{finishedNote}</p>}
    </section>
  );

  const panel = (
    <section className="card run" aria-labelledby="run-heading" id="run-details">
      <div className="run__head">
        <div className="run__headline">
          <h2 id="run-heading" className="card__title">
            {streaming || state.status === "awaiting_input" ? "Working" : "What the agent did"}
          </h2>
          <p className="run__status">
            {busy && <Spinner />}
            <span>{text}</span>
          </p>
        </div>
        {streaming && (
          <button type="button" className="btn btn--secondary btn--stop" onClick={onStop}>
            <Icon name="stop" />
            Stop
          </button>
        )}
        {!streaming && state.report !== null && (
          <button type="button" className="btn btn--ghost btn--small" aria-expanded onClick={() => setManual(false)}>
            Hide details
            <Icon name="chevron" className="icon--flip" />
          </button>
        )}
      </div>

      <PhaseStrip state={state} />
      <PlanChecklist state={state} />

      {state.notes.length > 0 && (
        <div className="run-section">
          <h3 className="run-section__title">Log</h3>
          <ol className="notes">
            {state.notes.map((note, index) => (
              <li key={`${index}-${note}`}>{note}</li>
            ))}
          </ol>
        </div>
      )}

      {finishedNote && <p className="run-summary__note">{finishedNote}</p>}
      {calls.length === 0 && streaming && state.started && <p className="muted">Waiting for the first lookup…</p>}
    </section>
  );

  return (
    <div ref={anchor} className="run-anchor">
      {open ? panel : summary}
    </div>
  );
}
