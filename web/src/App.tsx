import { useEffect, useMemo, useRef, useState } from "react";
import type { FormInput } from "@shared/types";
import { AmbiguityPicker } from "./components/AmbiguityPicker";
import { Chat } from "./components/Chat";
import { PrintSheet } from "./components/BridgeShelf";
import { EvidenceTrail } from "./components/EvidenceTrail";
import { IntakeForm } from "./components/IntakeForm";
import { Results, ResultsSkeleton } from "./components/Results";
import { RunPanel } from "./components/RunPanel";
import { RequestSummary, RunError } from "./components/RunNotices";
import { Footer, Header, SampleBanner } from "./components/SiteChrome";
import { HowItWorks, LoadingPanel, NotConfigured, ServerUnreachable } from "./components/StatePanels";
import { TrailContext } from "./components/TrailContext";
import { useHealth } from "./hooks/useHealth";
import { useMediaQuery } from "./hooks/useMediaQuery";
import { usePersistedTab } from "./hooks/usePersistedTab";
import { useRun } from "./hooks/useRun";
import { useTrailController } from "./hooks/useTrailController";
import { EMPTY_FORM, type FormValues } from "./lib/validate";

const SHEET_QUERY = "(max-width: 1023px)";

export function App() {
  const { state: healthState, recheck } = useHealth();
  const run = useRun();
  const { state } = run;

  const [form, setForm] = useState<FormValues>(EMPTY_FORM);
  const [submitted, setSubmitted] = useState<FormInput | null>(null);
  const [hasSearched, setHasSearched] = useState(false);
  const [tab, setTab] = usePersistedTab();
  const sheet = useMediaQuery(SHEET_QUERY);
  const resultsHeading = useRef<HTMLHeadingElement>(null);

  const knownCalls = useMemo(() => new Set(state.calls.map((entry) => entry.call.callId)), [state.calls]);
  const trail = useTrailController(knownCalls);

  // Move focus to the report once, when the first run of a search has finished. Waiting for the end matters: the
  // progress panel collapses at that point and would push an earlier focus target out of view.
  const resultsFocused = useRef(false);
  useEffect(() => {
    if (state.status === "idle") {
      resultsFocused.current = false;
    } else if (state.status === "finished" && state.reportCount > 0 && !resultsFocused.current) {
      resultsFocused.current = true;
      resultsHeading.current?.focus();
    }
  }, [state.status, state.reportCount]);

  const health = healthState.status === "ready" ? healthState.health : null;
  const fixtures = health?.mode === "fixtures" || state.mode === "fixtures";
  const inRun = state.status !== "idle";
  const streaming = state.status === "streaming";
  const locked = streaming || state.status === "awaiting_input";

  const patchForm = (patch: Partial<FormValues>) => setForm((current) => ({ ...current, ...patch }));
  const startSearch = (input: FormInput) => {
    setSubmitted(input);
    setHasSearched(true);
    run.start(input);
  };

  const body = () => {
    if (healthState.status === "loading") return <LoadingPanel />;
    if (healthState.status === "unreachable") return <ServerUnreachable onRecheck={recheck} />;
    return (
      <>
        {!healthState.health.ready && <NotConfigured problems={healthState.health.problems} onRecheck={recheck} />}
        <IntakeForm
          values={form}
          onChange={patchForm}
          onSubmit={startSearch}
          samples={healthState.health.mode === "fixtures" ? healthState.health.sampleInputs : []}
          disabled={!healthState.health.ready}
          failure={state.error}
          onRetry={run.retry}
          takeFocus={hasSearched}
        />
        <HowItWorks />
      </>
    );
  };

  return (
    <TrailContext.Provider value={trail.api}>
      <div className={`app${fixtures ? " app--sample" : ""}`}>
        {fixtures && <SampleBanner llm={health?.llm} />}
        <Header narrow={!inRun} />
        <div className="sr-only" role="status" aria-live="polite" aria-atomic="true">
          {state.announce}
        </div>

        {inRun ? (
          <div className={`shell shell--run${sheet ? " shell--has-sheet" : ""}`}>
            <main className="run-main">
              {submitted && <RequestSummary request={submitted} busy={streaming} onNewSearch={run.reset} />}
              <RunPanel state={state} onStop={run.stop} />
              {state.pending && <AmbiguityPicker key={state.pending.callId} pending={state.pending} onSubmit={run.answer} />}
              {state.error && <RunError failure={state.error} onRetry={run.retry} onEdit={run.reset} />}
              {state.report ? (
                <Results report={state.report} tab={tab} onTab={setTab} updating={streaming} headingRef={resultsHeading} />
              ) : (
                streaming && <ResultsSkeleton />
              )}
              {state.report && (
                <Chat
                  messages={state.messages}
                  locked={locked}
                  lockedReason={
                    streaming ? "Working on it. You can ask for changes once this finishes." : "Answer the question above to continue."
                  }
                  onSend={run.sendMessage}
                />
              )}
            </main>
            <EvidenceTrail calls={state.calls} turns={state.turns} controller={trail} live={streaming} sheet={sheet} />
          </div>
        ) : (
          <main className="shell shell--narrow">{body()}</main>
        )}

        <Footer narrow={!inRun} />
      </div>
      {state.report && <PrintSheet report={state.report} />}
    </TrailContext.Provider>
  );
}
