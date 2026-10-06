import { useEffect, useRef, useState } from "react";
import type { BuyItem, Report } from "@shared/types";
import { buyListToCsv, buyListToText, copyText, csvFileName, downloadCsv } from "../lib/exportReport";
import { formatAffinity } from "@shared/affinity";
import { plural } from "../lib/format";
import { CiteButton, EvidenceChips } from "./CiteButton";
import { ReducedChip, SignalChip, TrendChip } from "./Chips";
import { Icon } from "./Icon";

function Muted({ children }: { children: string }) {
  return <span className="muted">{children}</span>;
}

function EvidenceBlock({ item }: { item: BuyItem }) {
  const { evidence } = item;
  const { rank, localFit, trend, signalTrends } = evidence;
  return (
    <dl className="evidence">
      <div className="evidence__row">
        <dt>Matched signals</dt>
        <dd>
          {evidence.matchedSignals.length === 0 ? (
            <Muted>No single signal returned this title on its own.</Muted>
          ) : (
            <span className="chips">
              {evidence.matchedSignals.map((signal) => (
                <SignalChip key={signal.handle} entity={signal} />
              ))}
            </span>
          )}
        </dd>
      </div>

      <div className="evidence__row">
        <dt>Qloo results</dt>
        <dd>
          {evidence.recommendations.length === 0 ? (
            <Muted>No recommendation call returned this title.</Muted>
          ) : (
            <ul className="evidence__list">
              {evidence.recommendations.map((rec, index) => (
                <li key={`${rec.callId}-${index}`}>
                  {rec.signal && (
                    <>
                      For fans of <strong>{rec.signal.name}</strong>:{" "}
                    </>
                  )}
                  result {rec.position} of {rec.of}
                  {rec.affinity !== undefined && `, affinity ${formatAffinity(rec.affinity)}`} <CiteButton callId={rec.callId} />
                </li>
              ))}
            </ul>
          )}
        </dd>
      </div>

      <div className="evidence__row">
        <dt>Audience rank</dt>
        <dd>
          {rank ? (
            <>
              {rank.position} of {rank.of}
              {rank.affinity !== undefined && `, affinity ${formatAffinity(rank.affinity)}`} <CiteButton callId={rank.callId} />
            </>
          ) : (
            <Muted>Not ranked for this audience.</Muted>
          )}
        </dd>
      </div>

      <div className="evidence__row">
        <dt>Local fit</dt>
        <dd>
          {localFit ? (
            <>
              {localFit.summary} <CiteButton callId={localFit.callId} />
              <span className="evidence__fine">
                Within {localFit.within}: {localFit.areas} {plural(localFit.areas, "area")}
                {localFit.topAffinity !== undefined && `, top affinity ${formatAffinity(localFit.topAffinity)}`}
              </span>
            </>
          ) : (
            <Muted>Not checked.</Muted>
          )}
        </dd>
      </div>

      <div className="evidence__row">
        <dt>Trend</dt>
        <dd>
          {trend ? (
            <>
              <TrendChip direction={trend.direction} /> <CiteButton callId={trend.callId} />
              <span className="evidence__fine">{trend.basis}</span>
            </>
          ) : signalTrends && signalTrends.length > 0 ? (
            <ul className="evidence__list">
              {signalTrends.map((t) => (
                <li key={`${t.callId}-${t.entity.handle}`}>
                  Interest in <strong>{t.entity.name}</strong> <TrendChip direction={t.direction} /> <CiteButton callId={t.callId} />
                  <span className="evidence__fine">{t.basis}</span>
                </li>
              ))}
            </ul>
          ) : (
            <Muted>Qloo has no trend data for books, and no trend was checked for the signals behind this title.</Muted>
          )}
        </dd>
      </div>
    </dl>
  );
}

function BuyItemCard({ item }: { item: BuyItem }) {
  return (
    <li className="buy">
      <span className="buy__rank" aria-label={`Rank ${item.rank}`}>
        {item.rank}
      </span>
      <div className="buy__main">
        <h4 className="buy__title">
          {item.book.name}
          {item.book.year && <span className="buy__year"> ({item.book.year})</span>}
        </h4>
        <p className="buy__why">{item.rationale}</p>
        <EvidenceBlock item={item} />
        <div className="buy__foot">
          <EvidenceChips cites={item.cites} />
          {item.evidence.reduced && <ReducedChip />}
        </div>
      </div>
    </li>
  );
}

type CopyState = "idle" | "copied" | "failed";

export function BuyList({ report }: { report: Report }) {
  const [copy, setCopy] = useState<CopyState>("idle");
  const resetTimer = useRef<number>(0);
  const items = report.buyList;

  useEffect(() => () => window.clearTimeout(resetTimer.current), []);

  const onCopy = async () => {
    setCopy((await copyText(buyListToText(report))) ? "copied" : "failed");
    window.clearTimeout(resetTimer.current);
    resetTimer.current = window.setTimeout(() => setCopy("idle"), 2500);
  };

  return (
    <div>
      <div className="panel-head">
        <div>
          <p className="panel-head__lead">
            {items.length} {plural(items.length, "title")} ranked for this audience, each with the Qloo evidence behind it.
          </p>
          {report.budgetNote && <p className="budget-note">{report.budgetNote}</p>}
        </div>
        {items.length > 0 && (
          <div className="panel-head__actions">
            <button type="button" className="btn btn--secondary" onClick={onCopy}>
              <Icon name="copy" />
              Copy as text
            </button>
            <button type="button" className="btn btn--secondary" onClick={() => downloadCsv(csvFileName(report), buyListToCsv(report))}>
              <Icon name="download" />
              Download CSV
            </button>
            <span className="copy-status" role="status">
              {copy === "copied" ? "Copied to clipboard." : copy === "failed" ? "Couldn’t copy. Select the text and copy it by hand." : ""}
            </span>
          </div>
        )}
      </div>
      {items.length === 0 ? (
        <p className="empty-note">No titles passed the evidence check this time.</p>
      ) : (
        <>
          <p className="fine-note">Affinity scores come from separate Qloo calls and can’t be compared with each other.</p>
          <ol className="buys">
            {items.map((item) => (
              <BuyItemCard key={item.rank} item={item} />
            ))}
          </ol>
        </>
      )}
    </div>
  );
}
