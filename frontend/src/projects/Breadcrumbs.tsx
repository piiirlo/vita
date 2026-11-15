import { Fragment } from "react";
import { Link, useLocation } from "react-router";
import { innerPath, projectHome, sectionOf } from "./paths.ts";
import { useProject } from "./projectContext.ts";

const SECTION_NAMES = {
  charts: "Charts",
  datasets: "Datasets",
  "sql-lab": "SQL Lab",
  connections: "Connections",
} as const;

/** Projects / <project> / <section> / <item>, the last one as plain text. */
export default function Breadcrumbs() {
  const ctx = useProject();
  const { pathname } = useLocation();
  if (!ctx) return null;
  const inner = innerPath(pathname);
  const section = sectionOf(inner);
  const name = ctx.project?.name ?? (ctx.error ? "Project" : "…");

  const crumbs: { label: string; to?: string }[] = [{ label: "Projects", to: "/" }];
  crumbs.push({ label: name, to: section === "home" ? undefined : projectHome(ctx.id) });
  if (section in SECTION_NAMES) {
    const label = SECTION_NAMES[section as keyof typeof SECTION_NAMES];
    const sectionRoot = `/${section}`;
    const atRoot = inner === sectionRoot;
    crumbs.push({ label, to: atRoot ? undefined : `${projectHome(ctx.id)}${sectionRoot}` });
  }
  if (ctx.crumb && section !== "home") crumbs.push({ label: ctx.crumb });

  return (
    <nav aria-label="Breadcrumb" className="crumbs">
      {crumbs.map((c, i) => (
        <Fragment key={i}>
          {i > 0 && (
            <span className="crumbs-sep" aria-hidden>
              /
            </span>
          )}
          {c.to && i < crumbs.length - 1 ? (
            <Link to={c.to}>{c.label}</Link>
          ) : (
            <b aria-current="page">{c.label}</b>
          )}
        </Fragment>
      ))}
    </nav>
  );
}
