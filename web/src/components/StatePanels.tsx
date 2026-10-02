import type { ReactNode } from "react";
import { Icon, Spinner } from "./Icon";

interface PanelProps {
  title: string;
  children: ReactNode;
  action?: ReactNode;
}

function NoticePanel({ title, children, action, tone }: PanelProps & { tone: "warn" | "neutral" }) {
  return (
    <section className={`state-panel state-panel--${tone}`} aria-labelledby="state-panel-title">
      <Icon name={tone === "warn" ? "alert" : "info"} className="state-panel__icon" />
      <div>
        <h2 id="state-panel-title" className="state-panel__title">
          {title}
        </h2>
        {children}
        {action && <div className="state-panel__action">{action}</div>}
      </div>
    </section>
  );
}

/** Live mode without the keys it needs: say so plainly, never fake it. */
export function NotConfigured({ problems, onRecheck }: { problems: string[]; onRecheck: () => void }) {
  return (
    <NoticePanel
      tone="warn"
      title="Not configured"
      action={
        <button type="button" className="btn btn--secondary" onClick={onRecheck}>
          <Icon name="refresh" />
          Check again
        </button>
      }
    >
      <p>Shelfwise can’t build shelves until the server is set up. The form is switched off until then.</p>
      {problems.length > 0 && (
        <ul className="state-panel__list">
          {problems.map((problem) => (
            <li key={problem}>{problem}</li>
          ))}
        </ul>
      )}
    </NoticePanel>
  );
}

export function ServerUnreachable({ onRecheck }: { onRecheck: () => void }) {
  return (
    <NoticePanel
      tone="warn"
      title="Can’t reach the Shelfwise server"
      action={
        <button type="button" className="btn btn--secondary" onClick={onRecheck}>
          <Icon name="refresh" />
          Try again
        </button>
      }
    >
      <p>The page loaded, but the server that does the work isn’t answering. Check your connection, or try again in a moment.</p>
    </NoticePanel>
  );
}

export function LoadingPanel() {
  return (
    <p className="loading-line" role="status">
      <Spinner />
      Getting ready…
    </p>
  );
}

export function HowItWorks() {
  const steps = [
    { title: "Tell us your place and what patrons love", text: "A city, an age band, and a few shows, artists, games or books." },
    { title: "Watch the agent check Qloo", text: "Every lookup appears in an evidence trail you can open and inspect." },
    { title: "Take home shelf-talkers, a buy list and programme ideas", text: "Printable cards, ranked titles with their evidence, and event ideas." },
  ];
  return (
    <section className="how" aria-labelledby="how-heading">
      <h2 id="how-heading" className="how__heading">
        How it works
      </h2>
      <ol className="how__steps">
        {steps.map((step, index) => (
          <li key={step.title} className="how__step">
            <span className="how__num" aria-hidden="true">
              {index + 1}
            </span>
            <div>
              <h3 className="how__title">{step.title}</h3>
              <p className="how__text">{step.text}</p>
            </div>
          </li>
        ))}
      </ol>
    </section>
  );
}
