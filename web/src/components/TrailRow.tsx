import { useState } from "react";
import type { PreviewRow, ToolResultView } from "@shared/types";
import type { CallEntry } from "../lib/reduce";
import { entityTypeLabel, formatDuration } from "../lib/format";
import { shortTool } from "../lib/progress";
import { Icon } from "./Icon";
import { StatusChip, TrendChip } from "./Chips";

function Json({ value }: { value: unknown }) {
  return <pre className="code">{JSON.stringify(value, null, 2)}</pre>;
}

function RawResult({ raw }: { raw: unknown }) {
  const [open, setOpen] = useState(false);
  return (
    <details className="raw" onToggle={(event) => setOpen(event.currentTarget.open)}>
      <summary>Raw Qloo result</summary>
      {open &&
        (typeof raw === "string" ? (
          <p className="trail__fine">{raw}</p>
        ) : (
          <pre className="code code--scroll">{JSON.stringify(raw, null, 2)}</pre>
        ))}
    </details>
  );
}

function PreviewList({ rows }: { rows: PreviewRow[] }) {
  return (
    <>
      <ol className="preview">
        {rows.map((row, index) => {
          const type = entityTypeLabel(row.type);
          const meta = [type, row.year ? String(row.year) : null].filter(Boolean).join(" · ");
          return (
            <li key={`${row.handle ?? row.name}-${index}`} className="preview__row">
              <span className="preview__name">{row.name}</span>
              {meta && <span className="preview__meta">{meta}</span>}
              {row.affinity !== undefined && <span className="preview__affinity">affinity {row.affinity}</span>}
              {row.detail && <span className="preview__meta">{row.detail}</span>}
            </li>
          );
        })}
      </ol>
      <p className="trail__fine">Affinity values are shown as Qloo returned them and can’t be compared between different calls.</p>
    </>
  );
}

function ResultDetails({ result }: { result: ToolResultView }) {
  return (
    <>
      {result.resolved.length > 0 && (
        <section className="detail">
          <h5 className="detail__title">Resolved by Qloo</h5>
          <ul className="resolved">
            {result.resolved.map(({ input, entity }) => {
              const type = entityTypeLabel(entity.type);
              return (
                <li key={`${input}-${entity.handle}`}>
                  <span className="resolved__input">“{input}”</span>
                  <Icon name="arrow-right" />
                  <strong>{entity.name}</strong>
                  {(type || entity.year) && <span className="muted"> {[type, entity.year].filter(Boolean).join(" · ")}</span>}
                  <code className="resolved__id">{entity.entityId}</code>
                </li>
              );
            })}
          </ul>
        </section>
      )}

      {result.preview.length > 0 && (
        <section className="detail">
          <h5 className="detail__title">
            Results ({result.resultCount})
          </h5>
          <PreviewList rows={result.preview} />
        </section>
      )}

      {result.local && (
        <section className="detail">
          <h5 className="detail__title">Local fit</h5>
          <p>{result.local.summary}</p>
          <p className="trail__fine">
            {result.local.entity.name} within {result.local.within}: {result.local.areas} {result.local.areas === 1 ? "area" : "areas"}
            {result.local.topAffinity !== undefined && `, top affinity ${result.local.topAffinity}`}
          </p>
        </section>
      )}

      {result.trend && result.trend.length > 0 && (
        <section className="detail">
          <h5 className="detail__title">Trends</h5>
          <ul className="trend-list">
            {result.trend.map((trend) => (
              <li key={`${trend.callId}-${trend.entity.handle}`}>
                <strong>{trend.entity.name}</strong> <TrendChip direction={trend.direction} />
                <p className="trail__fine">
                  {trend.basis}
                  {trend.startDate && trend.endDate && ` (${trend.startDate} to ${trend.endDate}, ${trend.points} points)`}
                </p>
              </li>
            ))}
          </ul>
        </section>
      )}

      {result.warnings.length > 0 && (
        <section className="detail">
          <h5 className="detail__title">Warnings</h5>
          <ul className="warnings">
            {result.warnings.map((warning) => (
              <li key={warning}>
                <Icon name="alert" />
                <span>{warning}</span>
              </li>
            ))}
          </ul>
        </section>
      )}

      {result.error && (
        <section className="detail">
          <h5 className="detail__title">Error</h5>
          <p>
            <code>{result.error.code}</code> — {result.error.retryable ? "can be retried" : "not retryable"}
          </p>
          <p>{result.error.recovery}</p>
        </section>
      )}

      {result.requests.length > 0 && (
        <section className="detail">
          <h5 className="detail__title">Qloo requests</h5>
          <ul className="requests">
            {result.requests.map((request, index) => (
              <li key={`${request.path}-${index}`}>
                <code>{request.path}</code>
                <Json value={request.query} />
              </li>
            ))}
          </ul>
        </section>
      )}

      <RawResult raw={result.raw} />
    </>
  );
}

interface TrailRowProps {
  entry: CallEntry;
  expanded: boolean;
  highlighted: boolean;
  /** The run is still streaming, so a call without a result is in flight rather than abandoned. */
  live: boolean;
  onToggle: () => void;
}

export function TrailRow({ entry, expanded, highlighted, live, onToggle }: TrailRowProps) {
  const { call, result, retries } = entry;
  const latestRetry = retries[retries.length - 1];
  const panelId = `call-${call.callId}-details`;
  return (
    <li id={`call-${call.callId}`} className={`call${highlighted ? " call--highlight" : ""}${expanded ? " call--open" : ""}`}>
      <button type="button" className="call__head" aria-expanded={expanded} aria-controls={panelId} onClick={onToggle}>
        <span className="call__step" aria-label={`Step ${entry.step}`}>
          {entry.step}
        </span>
        <span className="call__main">
          <span className="call__label">{call.label}</span>
          <span className="call__chips">
            <span className="chip chip--tool">{shortTool(call.tool)}</span>
            <StatusChip status={result ? result.status : null} live={live} />
            {result?.cached && (
              <span className="chip chip--neutral" title="Served from Shelfwise’s cache; no new Qloo call was made.">
                Cached
              </span>
            )}
            {result?.sample && <span className="chip chip--sample">Sample</span>}
            {result && <span className="call__time">{formatDuration(result.durationMs)}</span>}
            <span className="call__id">{call.callId}</span>
          </span>
          {!result && !live && <span className="call__summary">The run ended before this lookup returned.</span>}
          {latestRetry && !result && live && (
            <span className="call__retry">
              <Icon name="refresh" />
              Retrying (attempt {latestRetry.attempt}) after {formatDuration(latestRetry.delayMs)}: {latestRetry.reason}
            </span>
          )}
          {latestRetry && result && (
            <span className="call__summary">
              <Icon name="refresh" /> Retried {retries.length} {retries.length === 1 ? "time" : "times"} before this result.
            </span>
          )}
          {result && <span className="call__summary">{result.summary}</span>}
        </span>
        <Icon name="chevron" className="call__chevron" />
      </button>
      {expanded && (
        <div id={panelId} className="call__body">
          <section className="detail">
            <h5 className="detail__title">Inputs</h5>
            <Json value={call.args} />
          </section>
          {retries.length > 0 && (
            <section className="detail">
              <h5 className="detail__title">Retries</h5>
              <ul className="warnings">
                {retries.map((retry) => (
                  <li key={retry.attempt}>
                    <Icon name="refresh" />
                    <span>
                      Retry (attempt {retry.attempt}): waited {formatDuration(retry.delayMs)}. {retry.reason}
                    </span>
                  </li>
                ))}
              </ul>
            </section>
          )}
          {result ? <ResultDetails result={result} /> : <p className="muted">Waiting for Qloo’s answer…</p>}
        </div>
      )}
    </li>
  );
}
