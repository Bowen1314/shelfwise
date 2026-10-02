import type { ProgrammeIdea } from "@shared/types";
import { entityTitle, PROGRAMME_LABELS } from "../lib/format";
import { EvidenceChips } from "./CiteButton";
import { SignalChip } from "./Chips";

function ProgrammeCard({ idea }: { idea: ProgrammeIdea }) {
  return (
    <article className="programme">
      <p className={`programme__kind programme__kind--${idea.kind}`}>{PROGRAMME_LABELS[idea.kind]}</p>
      <h4 className="programme__title">{idea.title}</h4>
      <p className="programme__text">{idea.description}</p>
      {idea.books.length > 0 && (
        <div className="programme__group">
          <p className="programme__label">Books featured</p>
          <ul className="chips">
            {idea.books.map((book) => (
              <li key={book.handle} className="chip chip--book">
                {entityTitle(book)}
              </li>
            ))}
          </ul>
        </div>
      )}
      {idea.signals.length > 0 && (
        <div className="programme__group">
          <p className="programme__label">Built on</p>
          <ul className="chips">
            {idea.signals.map((signal) => (
              <li key={signal.handle}>
                <SignalChip entity={signal} />
              </li>
            ))}
          </ul>
        </div>
      )}
      <div className="programme__foot">
        <EvidenceChips cites={idea.cites} />
      </div>
    </article>
  );
}

export function Programmes({ ideas }: { ideas: ProgrammeIdea[] }) {
  if (ideas.length === 0) {
    return <p className="empty-note">No programme ideas could be built on this evidence. Ask for one in the follow-up box below.</p>;
  }
  return (
    <div className="programmes">
      {ideas.map((idea) => (
        <ProgrammeCard key={idea.id} idea={idea} />
      ))}
    </div>
  );
}
