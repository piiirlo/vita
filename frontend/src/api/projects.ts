/** Projects: /api/projects (types mirror backend/app/schemas). */

import { json, request } from "./http.ts";


// ---------- projects ----------

export type ProjectSource = "database" | "file";

export type Project = {
  id: number;
  name: string;
  description: string | null;
  dashboard_count: number;
  dataset_count: number;
  chart_count: number;
  connection_count: number;
  saved_query_count: number;
  /** Where its data comes from: a connected database, an uploaded file, or both. */
  sources: ProjectSource[];
  /** The most recently changed dashboards (at most 3). */
  dashboards: { id: number; name: string; chart_count: number }[];
  /** The unfinished setup wizard (see setup/draft.ts); null = none. */
  setup_draft?: Record<string, unknown> | null;
  created_at: string;
  updated_at: string;
};

export const listProjects = () => request<Project[]>("/api/projects");

export const getProject = (id: number) => request<Project>(`/api/projects/${id}`);

export const createProject = (name: string) =>
  request<Project>("/api/projects", { method: "POST", body: json({ name }) });

export const renameProject = (id: number, name: string) =>
  request<Project>(`/api/projects/${id}`, { method: "PUT", body: json({ name }) });

/** Keep the unfinished setup wizard (never passwords), to resume it later. */
export const saveSetupDraft = (id: number, draft: object) =>
  request<Project>(`/api/projects/${id}/setup-draft`, { method: "PUT", body: json({ draft }) });

export const clearSetupDraft = (id: number) => request<void>(`/api/projects/${id}/setup-draft`, { method: "DELETE" });

/** Deletes everything in the project; `confirm` must be its name. */
export const deleteProject = (id: number, confirm: string) =>
  request<void>(`/api/projects/${id}?confirm=${encodeURIComponent(confirm)}`, { method: "DELETE" });
