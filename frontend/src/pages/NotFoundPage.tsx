import { Link } from "react-router";
import EmptyState from "../components/EmptyState.tsx";
import { usePageTitle } from "../components/usePageTitle.ts";

export default function NotFoundPage() {
  usePageTitle("Page not found");
  return (
    <div className="narrow-center">
      <EmptyState
        title="Page not found"
        action={
          <Link to="/dashboards" className="button primary">
            Go to dashboards
          </Link>
        }
      >
        This page doesn't exist. It may have been deleted, or the link is wrong.
      </EmptyState>
    </div>
  );
}
