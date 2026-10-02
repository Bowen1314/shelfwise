import { useEffect, useRef, useState, type FormEvent } from "react";
import type { Candidate, ResolutionChoice, ResolutionIssue } from "@shared/types";
import type { PendingInput } from "../lib/reduce";
import { entityTypeLabel } from "../lib/format";
import { Icon } from "./Icon";

const SKIP = "__skip__";

function CandidateOption({ issue, candidate, checked, onPick }: { issue: ResolutionIssue; candidate: Candidate; checked: boolean; onPick: () => void }) {
  const type = entityTypeLabel(candidate.type);
  return (
    <label className={`option${checked ? " option--checked" : ""}`}>
      <input className="option__input" type="radio" name={issue.issueId} checked={checked} onChange={onPick} />
      <span className="option__body">
        <span className="option__head">
          <span className="option__name">{candidate.name}</span>
          {type && <span className="chip chip--signal">{type}</span>}
          {candidate.releaseYear && <span className="option__year">{candidate.releaseYear}</span>}
        </span>
        {candidate.description && <span className="option__desc">{candidate.description}</span>}
      </span>
    </label>
  );
}

interface AmbiguityPickerProps {
  pending: PendingInput;
  onSubmit: (choices: ResolutionChoice[]) => void;
}

/** Shown when the agent pauses to ask which match the user meant. All answers are sent in one request. */
export function AmbiguityPicker({ pending, onSubmit }: AmbiguityPickerProps) {
  const headingRef = useRef<HTMLHeadingElement>(null);
  const [picks, setPicks] = useState<Record<string, string>>({});

  useEffect(() => {
    headingRef.current?.focus();
  }, []);

  const ambiguous = pending.issues.filter((issue) => issue.kind === "ambiguous");
  const complete = ambiguous.every((issue) => picks[issue.issueId] !== undefined);

  const submit = (event: FormEvent) => {
    event.preventDefault();
    if (!complete) return;
    const choices: ResolutionChoice[] = pending.issues.map((issue) => {
      const picked = picks[issue.issueId];
      const candidate = issue.kind === "ambiguous" && picked !== SKIP ? issue.candidates.find((c) => c.id === picked) : undefined;
      return { issueId: issue.issueId, pick: candidate ?? null };
    });
    onSubmit(choices);
  };

  return (
    <section className="card picker" aria-labelledby="picker-heading">
      <h2 id="picker-heading" className="card__title" ref={headingRef} tabIndex={-1}>
        Help Shelfwise pick the right match
      </h2>
      <p className="picker__lead">{pending.message}</p>
      <form onSubmit={submit}>
        {pending.issues.map((issue) =>
          issue.kind === "ambiguous" ? (
            <fieldset key={issue.issueId} className="issue">
              <legend className="issue__legend">Which “{issue.input}” did you mean?</legend>
              {issue.candidates.map((candidate) => (
                <CandidateOption
                  key={candidate.id}
                  issue={issue}
                  candidate={candidate}
                  checked={picks[issue.issueId] === candidate.id}
                  onPick={() => setPicks({ ...picks, [issue.issueId]: candidate.id })}
                />
              ))}
              <label className={`option option--skip${picks[issue.issueId] === SKIP ? " option--checked" : ""}`}>
                <input
                  className="option__input"
                  type="radio"
                  name={issue.issueId}
                  checked={picks[issue.issueId] === SKIP}
                  onChange={() => setPicks({ ...picks, [issue.issueId]: SKIP })}
                />
                <span className="option__body">
                  <span className="option__name">None of these — skip it</span>
                </span>
              </label>
            </fieldset>
          ) : (
            <div key={issue.issueId} className="issue issue--missing">
              <p className="issue__legend">
                <Icon name="info" />
                Qloo found no match for “{issue.input}”.
              </p>
              <p className="muted">It will be skipped. To use it, start a new search and word it differently.</p>
            </div>
          ),
        )}
        <div className="form__actions">
          <button type="submit" className="btn btn--primary" disabled={!complete}>
            {ambiguous.length === 0 ? "Continue without these" : "Continue"}
            <Icon name="arrow-right" />
          </button>
          {!complete && <p className="field__hint">Choose one option for each question to continue.</p>}
        </div>
      </form>
    </section>
  );
}
