import { useNow } from "../dashboards/hooks.ts";
import Breadcrumbs from "../projects/Breadcrumbs.tsx";
import { SearchCapsule } from "./PageHeader.tsx";

/** Ignara's top bar, on every page: where you are, the search (Ctrl/Cmd+K), today's date. */
export default function TopBar() {
  const now = useNow(60_000);
  const date = new Date(now);
  return (
    <div className="topbar">
      <Breadcrumbs />
      <SearchCapsule className="topbar-search" />
      <span className="date-chip" title={date.toLocaleString()}>
        <span className="live-dot" aria-hidden />
        {date.toLocaleDateString(undefined, { weekday: "long", day: "numeric", month: "long" })}
      </span>
    </div>
  );
}
