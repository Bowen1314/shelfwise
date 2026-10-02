import { useEffect, useId, useRef, useState, type FormEvent } from "react";
import type { ChatMessage } from "../lib/reduce";
import { Icon } from "./Icon";

const QUICK_PROMPTS = ["Make it for teens", "More translated fiction", "Shorter list", "Add a film night idea"];
const MAX_MESSAGE = 500;

interface ChatProps {
  messages: ChatMessage[];
  /** True while a run is streaming or paused for answers: the input is switched off. */
  locked: boolean;
  lockedReason: string;
  onSend: (text: string) => void;
}

export function Chat({ messages, locked, lockedReason, onSend }: ChatProps) {
  const id = useId();
  const [draft, setDraft] = useState("");
  const logRef = useRef<HTMLOListElement>(null);

  useEffect(() => {
    const log = logRef.current;
    if (log) log.scrollTop = log.scrollHeight;
  }, [messages.length]);

  const send = (text: string) => {
    const trimmed = text.trim();
    if (!trimmed || locked) return;
    onSend(trimmed);
    setDraft("");
  };

  const submit = (event: FormEvent) => {
    event.preventDefault();
    send(draft);
  };

  return (
    <section className="card chat" aria-labelledby={`${id}-heading`}>
      <h2 id={`${id}-heading`} className="card__title">
        Refine this shelf
      </h2>
      <p className="muted">Ask for a change and Shelfwise re-checks Qloo, then updates the report above.</p>

      {messages.length > 0 && (
        <ol className="chat__log" ref={logRef} role="log" aria-label="Conversation">
          {messages.map((message, index) => (
            <li key={`${index}-${message.role}`} className={`bubble bubble--${message.role}`}>
              <span className="bubble__who">{message.role === "user" ? "You" : "Shelfwise"}</span>
              <p>{message.text}</p>
            </li>
          ))}
        </ol>
      )}

      <ul className="chat__chips" aria-label="Quick prompts">
        {QUICK_PROMPTS.map((prompt) => (
          <li key={prompt}>
            <button type="button" className="chip-button" disabled={locked} onClick={() => send(prompt)}>
              {prompt}
            </button>
          </li>
        ))}
      </ul>

      <form className="chat__form" onSubmit={submit}>
        <label className="sr-only" htmlFor={`${id}-input`}>
          Ask for a change
        </label>
        <input
          id={`${id}-input`}
          className="input"
          type="text"
          maxLength={MAX_MESSAGE}
          autoComplete="off"
          placeholder="For example: more graphic novels, or a quieter reading list"
          value={draft}
          disabled={locked}
          onChange={(event) => setDraft(event.target.value)}
        />
        <button type="submit" className="btn btn--primary" disabled={locked || draft.trim() === ""}>
          Send
          <Icon name="send" />
        </button>
      </form>
      {locked && <p className="field__hint">{lockedReason}</p>}
    </section>
  );
}
