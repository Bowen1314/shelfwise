import { AGE_BANDS, type FormInput } from "@shared/types";
import type { RunFailure } from "../lib/failure";
import { plural } from "../lib/format";
import { Icon } from "./Icon";

interface RunErrorProps {
  failure: RunFailure;
  onRetry: () => void;
  onEdit: () => void;
}

/** A specific message plus a way forward. "Try again" resubmits the identical request. */
export function RunError({ failure, onRetry, onEdit }: RunErrorProps) {
  return (
    <div className="notice notice--error" role="alert">
      <Icon name="alert" />
      <div>
        <p className="notice__title">{failure.kind === "agent" ? "The agent ran into a problem" : "That didn’t go through"}</p>
        <p>{failure.message}</p>
        <div className="notice__actions">
          {failure.retryable && (
            <button type="button" className="btn btn--primary btn--small" onClick={onRetry}>
              <Icon name="refresh" />
              Try again
            </button>
          )}
          <button type="button" className="btn btn--secondary btn--small" onClick={onEdit}>
            Edit request
          </button>
        </div>
      </div>
    </div>
  );
}

interface RequestSummaryProps {
  request: FormInput;
  busy: boolean;
  onNewSearch: () => void;
}

/** What was asked, kept in view above the results. */
export function RequestSummary({ request, busy, onNewSearch }: RequestSummaryProps) {
  const band = AGE_BANDS.find((b) => b.id === request.ageBand)?.label ?? request.ageBand;
  return (
    <section className="request" aria-label="Your request">
      <div className="request__text">
        <p className="request__line">
          <strong>{request.place}</strong>
          <span aria-hidden="true"> · </span>
          <span>{band}</span>
          <span aria-hidden="true"> · </span>
          <span>
            {request.titleCount} {plural(request.titleCount, "title")}
          </span>
        </p>
        <p className="request__interests">{request.interests}</p>
      </div>
      <button type="button" className="btn btn--secondary btn--small" onClick={onNewSearch} disabled={busy}>
        <Icon name="sliders" />
        New search
      </button>
    </section>
  );
}
