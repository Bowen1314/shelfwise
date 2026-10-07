import { useEffect, useId, useRef, useState, type FormEvent } from "react";
import { AGE_BANDS, type AgeBandId, type FormInput } from "@shared/types";
import type { RunFailure } from "../lib/failure";
import {
  MAX_INTERESTS,
  MAX_TITLES,
  MIN_TITLES,
  validateForm,
  valuesFromInput,
  type FieldName,
  type FormValues,
} from "../lib/validate";
import { BudgetHelper } from "./BudgetHelper";
import { Icon } from "./Icon";

interface IntakeFormProps {
  values: FormValues;
  onChange: (patch: Partial<FormValues>) => void;
  onSubmit: (input: FormInput) => void;
  /** One-click example briefs: the server's sample inputs in fixtures mode, LIVE_EXAMPLES in live mode. */
  samples: FormInput[];
  /** True when the server is not configured: the form stays visible but cannot be used. */
  disabled: boolean;
  /** A failure from the last attempt that never produced a run (rate limit, server busy, ...). */
  failure: RunFailure | null;
  onRetry: () => void;
  /** The form has just come back after a search: put focus on its heading so keyboard users are not left on the page body. */
  takeFocus: boolean;
}

function bandLabel(id: AgeBandId): string {
  return AGE_BANDS.find((band) => band.id === id)?.label ?? id;
}

function excerpt(text: string, max: number): string {
  return text.length > max ? `${text.slice(0, max).trimEnd()}…` : text;
}

export function IntakeForm({ values, onChange, onSubmit, samples, disabled, failure, onRetry, takeFocus }: IntakeFormProps) {
  const id = useId();
  const heading = useRef<HTMLHeadingElement>(null);
  const focusOnMount = useRef(takeFocus);

  useEffect(() => {
    if (focusOnMount.current) heading.current?.focus();
  }, []);

  const [attempted, setAttempted] = useState(false);
  const refs = useRef<Partial<Record<FieldName, HTMLElement | null>>>({});

  const { errors, input } = validateForm(values);
  const shown = attempted ? errors : {};
  const band = AGE_BANDS.find((b) => b.id === values.ageBand);
  const interestsLength = values.interests.trim().length;

  const submit = (event: FormEvent) => {
    event.preventDefault();
    if (disabled) return;
    setAttempted(true);
    if (input) {
      onSubmit(input);
      return;
    }
    const first = (["place", "interests", "titleCount"] as const).find((name) => errors[name]);
    if (first) refs.current[first]?.focus();
  };

  const fieldProps = (name: FieldName, helpIds: string) => ({
    "aria-invalid": shown[name] ? true : undefined,
    "aria-describedby": shown[name] ? `${id}-${name}-error ${helpIds}` : helpIds,
  });

  return (
    <section className="card intake" aria-labelledby={`${id}-heading`}>
      <div className="intake__topline">
        <span>02</span>
        <span>New shelf brief</span>
        <span className="intake__topline-rule" aria-hidden="true" />
      </div>
      <h2 id={`${id}-heading`} ref={heading} tabIndex={-1} className="card__title">
        What should this shelf make possible?
      </h2>
      <p className="intake__lead">Give Shelfwise a place, an audience and a few cultural signals. It will connect the dots and write the shelf-talkers for you.</p>

      {failure && (
        <div className="notice notice--error" role="alert">
          <Icon name="alert" />
          <div>
            <p>{failure.message}</p>
            {failure.retryable && (
              <button type="button" className="btn btn--secondary btn--small" onClick={onRetry}>
                <Icon name="refresh" />
                Try again
              </button>
            )}
          </div>
        </div>
      )}

      {samples.length > 0 && (
        <div className="samples">
          <p className="samples__label" id={`${id}-samples`}>
            Try an example
          </p>
          <ul className="samples__list" aria-labelledby={`${id}-samples`}>
            {samples.map((sample) => (
              <li key={`${sample.place}-${sample.interests}`}>
                <button type="button" className="sample-chip" disabled={disabled} onClick={() => onChange(valuesFromInput(sample))}>
                  <span className="sample-chip__place">{sample.place}</span>
                  <span className="sample-chip__text">{excerpt(sample.interests, 44)}</span>
                </button>
              </li>
            ))}
          </ul>
        </div>
      )}

      <form className="form" onSubmit={submit} noValidate>
        <fieldset className="form__fieldset" disabled={disabled}>
          <div className="field-row">
            <div className="field">
              <label className="field__label" htmlFor={`${id}-place`}>
                Place
              </label>
              <input
                id={`${id}-place`}
                ref={(node) => {
                  refs.current.place = node;
                }}
                className="input"
                type="text"
                autoComplete="off"
                placeholder="Newark, NJ"
                value={values.place}
                onChange={(event) => onChange({ place: event.target.value })}
                {...fieldProps("place", `${id}-place-hint`)}
              />
              <p id={`${id}-place-hint`} className="field__hint">
                The city or region your patrons live in.
              </p>
              {shown.place && (
                <p id={`${id}-place-error`} className="field__error">
                  {shown.place}
                </p>
              )}
            </div>

            <div className="field">
              <label className="field__label" htmlFor={`${id}-age`}>
                Audience
              </label>
              <select
                id={`${id}-age`}
                className="input select"
                value={values.ageBand}
                onChange={(event) => onChange({ ageBand: event.target.value as AgeBandId })}
                aria-describedby={band?.note ? `${id}-age-note` : undefined}
              >
                {AGE_BANDS.map((option) => (
                  <option key={option.id} value={option.id}>
                    {option.label}
                  </option>
                ))}
              </select>
              {band?.note && (
                <p id={`${id}-age-note`} className="field__note">
                  <Icon name="info" />
                  <span>{band.note}</span>
                </p>
              )}
            </div>
          </div>

          <div className="field">
            <label className="field__label" htmlFor={`${id}-interests`}>
              What are patrons into right now?
            </label>
            <textarea
              id={`${id}-interests`}
              ref={(node) => {
                refs.current.interests = node;
              }}
              className="input textarea"
              rows={4}
              placeholder="Severance, Fleabag, Hades, Phoebe Bridgers"
              value={values.interests}
              onChange={(event) => onChange({ interests: event.target.value })}
              {...fieldProps("interests", `${id}-interests-hint ${id}-interests-count`)}
            />
            <div className="field__foot">
              <p id={`${id}-interests-hint`} className="field__hint">
                Shows, films, artists, games, podcasts, books — a few is plenty. Please don’t enter patron names or contact details.
              </p>
              <p
                id={`${id}-interests-count`}
                className={`counter${interestsLength > MAX_INTERESTS ? " counter--over" : ""}`}
              >
                {interestsLength} / {MAX_INTERESTS}
              </p>
            </div>
            {shown.interests && (
              <p id={`${id}-interests-error`} className="field__error">
                {shown.interests}
              </p>
            )}
          </div>

          <div className="field field--count">
            <label className="field__label" htmlFor={`${id}-count`}>
              How many titles?
            </label>
            <input
              id={`${id}-count`}
              ref={(node) => {
                refs.current.titleCount = node;
              }}
              className="input input--count"
              type="number"
              inputMode="numeric"
              min={MIN_TITLES}
              max={MAX_TITLES}
              step={1}
              value={values.titleCount}
              onChange={(event) => onChange({ titleCount: event.target.value })}
              {...fieldProps("titleCount", `${id}-count-hint`)}
            />
            <p id={`${id}-count-hint`} className="field__hint">
              How many you can buy or feature, {MIN_TITLES} to {MAX_TITLES}.
            </p>
            {shown.titleCount && (
              <p id={`${id}-titleCount-error`} className="field__error">
                {shown.titleCount}
              </p>
            )}
          </div>

          <BudgetHelper values={values} onChange={onChange} />

          <div className="form__actions">
            <button type="submit" className="btn btn--primary">
              Build my shelf
              <Icon name="arrow-right" />
            </button>
          </div>
        </fieldset>
      </form>
    </section>
  );
}
