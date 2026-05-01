/* The left icon rail. Fixed 48px column; primary nav only, no text labels
   (the active view is already on the path + screen title). */
import { Link, useSearchParams } from "react-router-dom";
import {
  IconHome,
  IconFlows,
  IconGraph,
  IconDiff,
  IconSettings,
} from "./icons";

type View = "home" | "flows" | "graph" | "diff" | "settings";

export function Rail({ active }: { active: View }) {
  const [params] = useSearchParams();
  const qs = params.toString();
  const items: Array<{ id: View; to: string; icon: JSX.Element; label: string }> = [
    { id: "home", to: `/?${qs}`, icon: <IconHome />, label: "Home" },
    // "Flows" uses the same root route - when a flow is selected we land
    // on /flow/:id and this item stays active.
    { id: "flows", to: `/?${qs}`, icon: <IconFlows />, label: "Flows" },
    { id: "graph", to: `/corrie?${qs}`, icon: <IconGraph />, label: "Graph . G" },
    { id: "diff", to: `/diff/?${qs}`, icon: <IconDiff />, label: "Diff . D" },
  ];
  return (
    <div className="rail">
      {items.map((it) => (
        <Link
          key={it.id}
          to={it.to}
          className={`rail-btn ${active === it.id ? "is-active" : ""}`}
          title={it.label}
          aria-label={it.label}
        >
          {it.icon}
        </Link>
      ))}
      <div className="rail-spacer" />
      <Link
        to="/settings"
        className={`rail-btn ${active === "settings" ? "is-active" : ""}`}
        title="Settings"
        aria-label="Settings"
      >
        <IconSettings />
      </Link>
    </div>
  );
}
