/** Login state shared by the app: the context, useAuth() and helpers. The provider is in
 * AuthContext.tsx. */
import { createContext, useContext } from "react";
import type { CurrentUser } from "../api.ts";

export type AuthState =
  | { status: "loading" }
  | { status: "anonymous"; /** A session ended while the app was in use. */ expired: boolean }
  | { status: "authenticated"; user: CurrentUser };

export type AuthValue = {
  state: AuthState;
  loggedIn(user: CurrentUser): void;
  logout(): Promise<void>;
  /** The backend couldn't be reached to check the session. */
  error: string | null;
  retry(): void;
};

export const AuthContext = createContext<AuthValue | null>(null);

export function useAuth(): AuthValue {
  const value = useContext(AuthContext);
  if (!value) throw new Error("useAuth must be used inside <AuthProvider>");
  return value;
}

/** Where to go after logging in: a same-site path from ?next=, else the dashboards. */
export function safeNext(next: string | null): string {
  if (!next || !next.startsWith("/") || next.startsWith("//") || next.startsWith("/\\") || next.startsWith("/login")) {
    return "/dashboards";
  }
  return next;
}
