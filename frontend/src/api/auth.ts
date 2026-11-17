/** Login and the current user: /api/auth (types mirror backend/app/schemas). */

import { json, request } from "./http.ts";


// ---------- auth ----------

export type CurrentUser = { username: string };

/** Throws ApiError: 401 wrong credentials, 429 too many failed attempts. */
export const login = (username: string, password: string) =>
  request<CurrentUser>("/api/auth/login", { method: "POST", body: json({ username, password }) });

export const logout = () => request<void>("/api/auth/logout", { method: "POST" });

/** The logged-in user; throws ApiError 401 when not logged in. */
export const fetchCurrentUser = () => request<CurrentUser>("/api/auth/me");

export const changePassword = (currentPassword: string, newPassword: string) =>
  request<void>("/api/auth/password", {
    method: "POST",
    body: json({ current_password: currentPassword, new_password: newPassword }),
  });
