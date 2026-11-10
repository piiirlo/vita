import { Compass } from "lucide-react";
import { Link } from "react-router";
import EmptyState from "../components/EmptyState.tsx";
import { usePageTitle } from "../components/usePageTitle.ts";

export default function NotFoundPage() {
  usePageTitle("Page not found");
  return (
    <div className="narrow-center">
      <EmptyState
        icon={Compass}
        title="Page not found"
        action={
          <Link to="/dashboards" className="button primary">
            Go to dashboards
          </Link>
        }
      >
        <span className="not-found-code" aria-hidden>
          4<span>0</span>4
        </span>
        Nothing lives at this address. It may have moved, or the link is wrong.
      </EmptyState>
    </div>
  );
}
