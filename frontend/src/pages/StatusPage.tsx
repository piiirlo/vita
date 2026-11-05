import { useCallback, useEffect, useState } from "react";
import { fetchHealth, type HealthResponse } from "../api.ts";
import { usePageTitle } from "../components/usePageTitle.ts";

type HealthState =
  | { kind: "loading" }
  | { kind: "loaded"; health: HealthResponse }
  | { kind: "unreachable"; message: string };

function StatusRow({ label, ok, text }: { label: string; ok: boolean; text: string }) {
  return (
    <div className="status-row">
      <span className={ok ? "dot dot-ok" : "dot dot-error"} />
      <span className="status-label">{label}</span>
      <span className={ok ? "text-ok" : "text-error"}>{text}</span>
    </div>
  );
}

export default function StatusPage() {
  usePageTitle("Status");
  const [state, setState] = useState<HealthState>({ kind: "loading" });

  const check = useCallback(async () => {
    setState({ kind: "loading" });
    try {
      setState({ kind: "loaded", health: await fetchHealth() });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      setState({ kind: "unreachable", message });
    }
  }, []);

  useEffect(() => {
    void check();
  }, [check]);

  return (
    <div className="narrow">
      <h1>System status</h1>

      <section className="card">
        {state.kind === "loading" && <p>Checking…</p>}

        {state.kind === "unreachable" && (
          <>
            <StatusRow label="Backend" ok={false} text="unreachable" />
            <StatusRow label="Database" ok={false} text="unknown" />
            <p className="muted small">{state.message}</p>
          </>
        )}

        {state.kind === "loaded" && (
          <>
            <StatusRow label="Backend" ok text="OK" />
            <StatusRow
              label="Database"
              ok={state.health.database === "ok"}
              text={state.health.database === "ok" ? "OK" : "error"}
            />
            {state.health.detail && <p className="muted small">{state.health.detail}</p>}
          </>
        )}
      </section>

      <button onClick={() => void check()} disabled={state.kind === "loading"}>
        Check again
      </button>
    </div>
  );
}
