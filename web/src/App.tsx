import { useEffect, useMemo, useRef, useState } from "react";
import { AGE_BANDS, type FormInput } from "@shared/types";
import { AmbiguityPicker } from "./components/AmbiguityPicker";
import { Chat } from "./components/Chat";
import { EvidenceTrail } from "./components/EvidenceTrail";
import { IntakeForm } from "./components/IntakeForm";
import { PrintArea, PrintDesk, TALKERS_ONLY, type PrintSections } from "./components/PrintDesk";
import { RecentRuns } from "./components/RecentRuns";
import { Results, ResultsSkeleton } from "./components/Results";
import { RunPanel } from "./components/RunPanel";
import { RequestSummary, RunError } from "./components/RunNotices";
import { Header, SampleBanner, type View } from "./components/SiteChrome";
import { HowItWorks, LoadingPanel, NotConfigured, ServerUnreachable } from "./components/StatePanels";
import { TrailContext } from "./components/TrailContext";
import { useHealth } from "./hooks/useHealth";
import { useMediaQuery } from "./hooks/useMediaQuery";
import { usePersistedTab } from "./hooks/usePersistedTab";
import { useRecentRuns } from "./hooks/useRecentRuns";
import { useRun } from "./hooks/useRun";
import { useTrailController } from "./hooks/useTrailController";
import { LIVE_EXAMPLES } from "./lib/examples";
import { recentRunFrom } from "./lib/recentRuns";
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
  const landingHeading = useRef<HTMLHeadingElement>(null);
  /** Heading of the Recent runs, saved-run and Print desk views (only one is mounted at a time). */
  const viewHeading = useRef<HTMLHeadingElement>(null);

  const recent = useRecentRuns();
  const [view, setView] = useState<View>("build");
  /** The saved run open read-only in Recent runs. */
  const [openedId, setOpenedId] = useState<string | null>(null);
  /** A saved run sent to the Print desk; null means the desk prints the current run's report. */
  const [printPick, setPrintPick] = useState<string | null>(null);
  const [printSections, setPrintSections] = useState<PrintSections>(TALKERS_ONLY);

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

  // Keep each finished report in Recent runs. Keyed on `done` alone on purpose: it is a new object whenever a turn
  // ends, so this runs once per turn. recentRunFrom decides whether the run is worth keeping (completed with a
  // report, not paused or failed); saving the same session again replaces its entry.
  const saveRecent = recent.save;
  useEffect(() => {
    const band = submitted ? (AGE_BANDS.find((b) => b.id === submitted.ageBand)?.label ?? submitted.ageBand) : null;
    const entry = recentRunFrom(
      state,
      submitted && band ? { place: submitted.place, interests: submitted.interests, audience: band, titleCount: submitted.titleCount } : null,
    );
    if (entry) saveRecent(entry);
  }, [state.done]);

  // After a change of view from the navigation (or opening a saved run), move focus to the new view's heading.
  const pendingFocus = useRef(false);
  useEffect(() => {
    if (!pendingFocus.current) return;
    pendingFocus.current = false;
    (viewHeading.current ?? resultsHeading.current ?? landingHeading.current)?.focus();
  }, [view, openedId]);

  const health = healthState.status === "ready" ? healthState.health : null;
  const fixtures = health?.mode === "fixtures" || state.mode === "fixtures";
  const inRun = state.status !== "idle";
  const streaming = state.status === "streaming";
  const locked = streaming || state.status === "awaiting_input";

  const opened = view === "recent" && openedId ? (recent.runs.find((entry) => entry.sessionId === openedId) ?? null) : null;
  const picked = printPick ? (recent.runs.find((entry) => entry.sessionId === printPick) ?? null) : null;
  const deskReport = picked?.report ?? state.report;
  const deskSource = picked ? { kind: "saved" as const, savedAt: picked.savedAt } : state.report ? { kind: "current" as const } : null;
  // The print-only area follows the report on screen. Outside the desk it holds the shelf-talkers only, which is
  // what the Bridge shelf's own print button has always printed.
  const printReport = view === "print" ? deskReport : (opened?.report ?? state.report);

  const patchForm = (patch: Partial<FormValues>) => setForm((current) => ({ ...current, ...patch }));
  const startSearch = (input: FormInput) => {
    setSubmitted(input);
    setHasSearched(true);
    setPrintPick(null);
    run.start(input);
  };

  const navigate = (next: View) => {
    // The current item does nothing, except that Recent runs leads back to the list from an open saved run.
    if (next === view && !(next === "recent" && openedId)) return;
    // Going to the desk while reading a saved run prints that run.
    if (next === "print" && view === "recent" && opened) setPrintPick(opened.sessionId);
    if (next === "recent") setOpenedId(null);
    pendingFocus.current = true;
    setView(next);
  };
  const openSaved = (sessionId: string | null) => {
    pendingFocus.current = true;
    setOpenedId(sessionId);
  };
  const printSaved = (sessionId: string) => {
    setPrintPick(sessionId);
    pendingFocus.current = true;
    setView("print");
  };
  const removeSaved = (sessionId: string) => {
    recent.remove(sessionId);
    if (printPick === sessionId) setPrintPick(null);
    if (openedId === sessionId) openSaved(null);
  };

  const crumb = view === "recent" ? (opened ? "Saved shelf" : "Recent runs") : view === "print" ? "Print desk" : inRun ? "Shelf report" : "New shelf";
  const narrow = view === "build" && !inRun;

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
          samples={healthState.health.mode === "fixtures" ? healthState.health.sampleInputs : LIVE_EXAMPLES}
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
      <div className={`app workspace${fixtures ? " app--sample" : ""}`}>
        {fixtures && <SampleBanner llm={health?.llm} />}
        <div className="workspace-shell">
          <Header narrow={narrow} view={view} onNavigate={navigate} crumb={crumb} />
          <div className="workspace-content">
            <div className="sr-only" role="status" aria-live="polite" aria-atomic="true">
              {state.announce}
            </div>

            {view === "recent" ? (
              <RecentRuns
                runs={recent.runs}
                opened={opened}
                sheet={sheet}
                headingRef={viewHeading}
                onOpen={openSaved}
                onPrint={printSaved}
                onRemove={removeSaved}
                onClear={() => {
                  recent.clear();
                  setPrintPick(null);
                }}
                onBuild={() => navigate("build")}
              />
            ) : view === "print" ? (
              <PrintDesk
                report={deskReport}
                source={deskSource}
                hasCurrent={state.report !== null}
                building={inRun && state.report === null && state.status !== "finished"}
                hasRecent={recent.runs.length > 0}
                sections={printSections}
                onSections={setPrintSections}
                onUseCurrent={() => setPrintPick(null)}
                onNavigate={navigate}
                headingRef={viewHeading}
              />
            ) : inRun ? (
              <div className={`shell shell--run work-stage work-stage--run${sheet ? " shell--has-sheet" : ""}`}>
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
              <main className="shell shell--narrow work-stage work-stage--landing">
                <section className="landing-main" aria-labelledby="landing-title">
                  <div className="landing-heading">
                    <p className="landing-heading__eyebrow">New shelf brief</p>
                    <h2 id="landing-title" tabIndex={-1} ref={landingHeading}>
                      Build a shelf your community will actually use.
                    </h2>
                    <p>Start with a place and a few cultural signals. Shelfwise turns them into grounded recommendations, shelf-talkers and programme ideas.</p>
                  </div>
                  {body()}
                </section>
                <aside className="preview-panel" aria-labelledby="preview-title">
                  <div className="preview-panel__topline"><span>Preview</span><span className="preview-panel__status">Ready</span></div>
                  <h2 id="preview-title">Your shelf brief</h2>
                  <p className="preview-panel__lead">A live summary of what you are asking Shelfwise to make.</p>
                  <div className="preview-panel__blank">
                    <div className="preview-panel__glyph" aria-hidden="true"><span /><span /><span /></div>
                    <strong>{form.place.trim() || "Choose a place to begin"}</strong>
                    <span>{form.interests.trim() || "Your taste signals will appear here."}</span>
                  </div>
                  <dl className="preview-panel__stats">
                    <div><dt>Audience</dt><dd>{AGE_BANDS.find((band) => band.id === form.ageBand)?.label ?? "Whole community"}</dd></div>
                    <div><dt>Titles</dt><dd>{form.titleCount || "8"}</dd></div>
                    <div><dt>Outputs</dt><dd>3 formats</dd></div>
                  </dl>
                  <p className="preview-panel__fine">Every recommendation includes the evidence used to make it.</p>
                </aside>
              </main>
            )}
          </div>
        </div>
      </div>
      <PrintArea report={printReport} sections={view === "print" ? printSections : TALKERS_ONLY} />
    </TrailContext.Provider>
  );
}
