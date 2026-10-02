import { useId, useState } from "react";
import { budgetMath, MAX_TITLES, MIN_TITLES, type FormValues } from "../lib/validate";
import { plural } from "../lib/format";

interface BudgetHelperProps {
  values: Pick<FormValues, "budget" | "avgPrice">;
  onChange: (patch: Partial<FormValues>) => void;
}

/** Optional: turns a budget and an average price into a title count. Shelfwise only shows this arithmetic. */
export function BudgetHelper({ values, onChange }: BudgetHelperProps) {
  const id = useId();
  const [applied, setApplied] = useState<number | null>(null);
  const math = budgetMath(values.budget, values.avgPrice);

  const edit = (patch: Partial<FormValues>) => {
    setApplied(null);
    onChange(patch);
  };

  return (
    <details className="disclosure">
      <summary className="disclosure__summary">Work it out from a budget</summary>
      <div className="disclosure__body">
        <div className="field-row">
          <div className="field">
            <label className="field__label" htmlFor={`${id}-budget`}>
              Budget
            </label>
            <input
              id={`${id}-budget`}
              className="input"
              type="number"
              inputMode="decimal"
              min="0"
              step="any"
              value={values.budget}
              onChange={(event) => edit({ budget: event.target.value })}
            />
          </div>
          <div className="field">
            <label className="field__label" htmlFor={`${id}-price`}>
              Average price per title
            </label>
            <input
              id={`${id}-price`}
              className="input"
              type="number"
              inputMode="decimal"
              min="0"
              step="any"
              value={values.avgPrice}
              onChange={(event) => edit({ avgPrice: event.target.value })}
            />
          </div>
        </div>
        <p className="field__hint">Use the same currency for both. Qloo returns no prices, so this is your own arithmetic.</p>

        {math && (
          <div className="budget-result" aria-live="polite">
            <p className="budget-result__sum">
              {math.budget} / {math.avgPrice} = {math.titles} {plural(math.titles, "title")}
              {!math.exact && <span className="muted"> (rounded down)</span>}
            </p>
            {math.clamped !== math.titles && (
              <p className="field__hint">
                {math.titles} is outside {MIN_TITLES}–{MAX_TITLES}, so “Use this number” sets {math.clamped}.
              </p>
            )}
            <button
              type="button"
              className="btn btn--secondary btn--small"
              onClick={() => {
                onChange({ titleCount: String(math.clamped) });
                setApplied(math.clamped);
              }}
            >
              Use this number
            </button>
            {applied !== null && (
              <span className="budget-result__applied" role="status">
                Title count set to {applied}.
              </span>
            )}
          </div>
        )}
      </div>
    </details>
  );
}
