import type { BridgeCard, Report } from "@shared/types";
import { SAMPLE_DATA_LABEL } from "@shared/types";
import { entityTitle } from "../lib/format";
import { EvidenceChips } from "./CiteButton";
import { ReducedChip } from "./Chips";
import { Icon } from "./Icon";

const CARDS_PER_PAGE = 6;

function lovedLine(card: BridgeCard): string {
  return card.loved.map((entity) => entity.name).join(" + ");
}

function tryTitle(card: BridgeCard): string {
  return `Try ${entityTitle(card.book)}`;
}

function ShelfTalker({ card }: { card: BridgeCard }) {
  return (
    <article className="talker">
      <p className="talker__eyebrow">Loved {lovedLine(card)}?</p>
      <h4 className="talker__title">
        Try {card.book.name}
        {card.book.year && <span className="talker__year"> ({card.book.year})</span>}
      </h4>
      <p className="talker__why">{card.why}</p>
      <div className="talker__foot">
        <EvidenceChips cites={card.cites} />
        {card.reduced && <ReducedChip />}
      </div>
    </article>
  );
}

export function BridgeShelf({ report }: { report: Report }) {
  const cards = report.bridgeShelf;
  return (
    <div>
      <div className="panel-head">
        <p className="panel-head__lead">
          Cards for the shelf: what patrons already love, and the book to try next.
        </p>
        <button type="button" className="btn btn--primary" onClick={() => window.print()} disabled={cards.length === 0}>
          <Icon name="printer" />
          Print shelf-talkers
        </button>
      </div>
      {cards.length === 0 ? (
        <p className="empty-note">No shelf-talkers could be written from this search. Try adding more things patrons love.</p>
      ) : (
        <div className="talkers">
          {cards.map((card) => (
            <ShelfTalker key={card.id} card={card} />
          ))}
        </div>
      )}
    </div>
  );
}

function PrintCard({ card, sample }: { card: BridgeCard; sample: boolean }) {
  const cites = [...new Set(card.cites.map((cite) => cite.callId))];
  return (
    <article className="print-card">
      <p className="print-card__eyebrow">Loved {lovedLine(card)}?</p>
      <p className="print-card__title">{tryTitle(card)}</p>
      <p className="print-card__why">{card.why}</p>
      <div className="print-card__foot">
        {cites.length > 0 && <p>Evidence: {cites.join(" · ")}</p>}
        {card.reduced && <p>Reduced confidence</p>}
        {sample && <p className="print-card__sample">SAMPLE DATA</p>}
      </div>
    </article>
  );
}

/** How many printed pages the shelf-talkers take. */
export function talkerPageCount(report: Report): number {
  return Math.ceil(report.bridgeShelf.length / CARDS_PER_PAGE);
}

/**
 * Print-only pages of shelf-talkers: six cards (2 x 3) per page, one page per group, so the layout never depends on
 * where the browser decides to break. Rendered inside the Print desk's print-only sheet (see PrintArea).
 */
export function PrintShelfTalkers({ report }: { report: Report }) {
  const pages: BridgeCard[][] = [];
  for (let i = 0; i < report.bridgeShelf.length; i += CARDS_PER_PAGE) {
    pages.push(report.bridgeShelf.slice(i, i + CARDS_PER_PAGE));
  }
  return (
    <>
      {pages.map((cards, index) => (
        <section key={cards[0]?.id ?? index} className="print-page">
          {report.sample && <p className="print-page__sample">{SAMPLE_DATA_LABEL}</p>}
          <div className="print-grid">
            {cards.map((card) => (
              <PrintCard key={card.id} card={card} sample={report.sample} />
            ))}
          </div>
        </section>
      ))}
    </>
  );
}
