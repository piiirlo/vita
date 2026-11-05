import { useCallback, useEffect, useMemo, useState, type ReactNode } from "react";
import { ApiError, fetchCurrentUser, logout as apiLogout, UNAUTHORIZED_EVENT, type CurrentUser } from "../api.ts";
import { AuthContext, type AuthState } from "./auth.ts";

export function AuthProvider({ children }: { children: ReactNode }) {
  const [state, setState] = useState<AuthState>({ status: "loading" });
  const [error, setError] = useState<string | null>(null);
  const [attempt, setAttempt] = useState(0);

  useEffect(() => {
    let cancelled = false;
    setError(null);
    fetchCurrentUser()
      .then((user) => !cancelled && setState({ status: "authenticated", user }))
      .catch((err: unknown) => {
        if (cancelled) return;
        if (err instanceof ApiError && err.status === 401) setState({ status: "anonymous", expired: false });
        else setError(err instanceof Error ? err.message : String(err));
      });
    return () => {
      cancelled = true;
    };
  }, [attempt]);

  // Any API call answered with 401: the session is gone, so go to the login page.
  useEffect(() => {
    const onUnauthorized = () =>
      setState((s) => (s.status === "authenticated" ? { status: "anonymous", expired: true } : s));
    window.addEventListener(UNAUTHORIZED_EVENT, onUnauthorized);
    return () => window.removeEventListener(UNAUTHORIZED_EVENT, onUnauthorized);
  }, []);

  const loggedIn = useCallback((user: CurrentUser) => setState({ status: "authenticated", user }), []);
  const logout = useCallback(async () => {
    await apiLogout();
    setState({ status: "anonymous", expired: false });
  }, []);
  const retry = useCallback(() => setAttempt((a) => a + 1), []);

  const value = useMemo(() => ({ state, loggedIn, logout, error, retry }), [state, loggedIn, logout, error, retry]);
  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}
