import { Component, type ErrorInfo, type ReactNode } from "react";
import { Link } from "react-router";

type Props = { children: ReactNode };
type State = { error: Error | null };

/** A crash while rendering a page shows a friendly message instead of a blank screen.
 * The app shell keys it by path, so navigating elsewhere resets it. */
export default class ErrorBoundary extends Component<Props, State> {
  state: State = { error: null };

  static getDerivedStateFromError(error: unknown): State {
    return { error: error instanceof Error ? error : new Error(String(error)) };
  }

  componentDidCatch(error: Error, info: ErrorInfo) {
    console.error("Page crashed:", error, info.componentStack);
  }

  render() {
    if (!this.state.error) return this.props.children;
    return (
      <div className="card empty crash" role="alert">
        <h1>Something went wrong</h1>
        <p>This page ran into an unexpected problem. Your saved work is not affected.</p>
        <p className="muted small mono">{this.state.error.message}</p>
        <div className="actions center">
          <button className="primary" onClick={() => window.location.reload()}>
            Reload the page
          </button>
          <Link to="/dashboards" className="button">
            Go to dashboards
          </Link>
        </div>
      </div>
    );
  }
}
