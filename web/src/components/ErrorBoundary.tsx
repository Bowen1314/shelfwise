import { Component, type ErrorInfo, type ReactNode } from "react";

interface State {
  failed: boolean;
}

/** Last line of defence: a calm message instead of a blank page if a render ever throws. */
export class ErrorBoundary extends Component<{ children: ReactNode }, State> {
  override state: State = { failed: false };

  static getDerivedStateFromError(): State {
    return { failed: true };
  }

  override componentDidCatch(error: Error, info: ErrorInfo): void {
    console.error("Shelfwise render error", error, info.componentStack);
  }

  override render(): ReactNode {
    if (!this.state.failed) return this.props.children;
    return (
      <main className="shell shell--narrow">
        <section className="state-panel state-panel--warn">
          <div>
            <h1 className="state-panel__title">Something went wrong showing this page</h1>
            <p>This view can’t continue. Reload the page to start again.</p>
            <div className="state-panel__action">
              <button type="button" className="btn btn--primary" onClick={() => window.location.reload()}>
                Reload
              </button>
            </div>
          </div>
        </section>
      </main>
    );
  }
}
