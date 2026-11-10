import { useCallback, useEffect, useState } from "react";
import { fetchHealth, type HealthResponse } from "../api.ts";
import { usePageTitle } from "../components/usePageTitle.ts";
import PageHeader from "../shell/PageHeader.tsx";
import { Button } from "../components/ui/button.tsx";
import { SkeletonLines } from "../components/ui/skeleton.tsx";
import { RefreshCw } from "lucide-react";

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
      <PageHeader
        eyebrow="Instrument check"
        title="System status"
        search={false}
        actions={
          <Button onClick={() => void check()} disabled={state.kind === "loading"}>
            <RefreshCw size={15} aria-hidden /> Check again
          </Button>
        }
      />

      <section className="card">
        {state.kind === "loading" && <SkeletonLines lines={2} label="Checking…" />}

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
    </div>
  );
}
