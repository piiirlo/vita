import { useEffect, useState, type FormEvent } from "react";
import { Navigate, useNavigate, useSearchParams } from "react-router";
import { ApiError, login } from "../api.ts";
import { safeNext, useAuth } from "../auth/auth.ts";
import { usePageTitle } from "../components/usePageTitle.ts";

export default function LoginPage() {
  usePageTitle("Log in");
  const { state, loggedIn } = useAuth();
  const [search] = useSearchParams();
  const navigate = useNavigate();
  const next = safeNext(search.get("next"));

  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [waitUntil, setWaitUntil] = useState<number | null>(null);
  const [now, setNow] = useState(() => Date.now());

  // Count down while logins are refused after too many failures.
  useEffect(() => {
    if (waitUntil === null) return;
    const timer = setInterval(() => {
      setNow(Date.now());
      if (Date.now() >= waitUntil) setWaitUntil(null);
    }, 500);
    return () => clearInterval(timer);
  }, [waitUntil]);

  if (state.status === "authenticated") return <Navigate to={next} replace />;

  const secondsLeft = waitUntil === null ? 0 : Math.max(0, Math.ceil((waitUntil - now) / 1000));

  async function submit(event: FormEvent) {
    event.preventDefault();
    if (!username.trim() || !password) {
      setError("Enter your username and password.");
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const user = await login(username.trim(), password);
      loggedIn(user);
      void navigate(next, { replace: true });
    } catch (err) {
      setPassword("");
      if (err instanceof ApiError && err.status === 429) {
        const match = /(\d+) seconds/.exec(err.message);
        setWaitUntil(Date.now() + (match ? Number(match[1]) : 30) * 1000);
        setNow(Date.now());
        setError("Too many failed attempts.");
      } else {
        setError(err instanceof Error ? err.message : String(err));
      }
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="login-page">
      <form className="card form login-card" onSubmit={(e) => void submit(e)} aria-label="Log in">
        <div className="login-brand">Vita</div>
        <h1 className="login-title">Log in</h1>
        {state.status === "anonymous" && state.expired && !error && (
          <p className="alert alert-warning">Your session has ended. Please log in again.</p>
        )}
        {error && (
          <p className="alert alert-error" role="alert">
            {error}
            {secondsLeft > 0 && ` Try again in ${secondsLeft} s.`}
          </p>
        )}
        <label>
          Username
          <input name="username" autoComplete="username" value={username} onChange={(e) => setUsername(e.target.value)} autoFocus />
        </label>
        <label>
          Password
          <input
            name="password"
            type="password"
            autoComplete="current-password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
          />
        </label>
        <button type="submit" className="primary login-submit" disabled={busy || secondsLeft > 0}>
          {busy ? "Logging in…" : "Log in"}
        </button>
      </form>
    </div>
  );
}
