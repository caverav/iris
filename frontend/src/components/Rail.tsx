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

type View = "home" | "flows" | "graph" | "diff";

export function Rail({ active }: { active: View }) {
  const [params] = useSearchParams();
  const qs = params.toString();
  const items: Array<{ id: View; to: string; icon: JSX.Element; label: string }> = [
    { id: "home", to: `/?${qs}`, icon: <IconHome />, label: "Home" },
    // "Flows" uses the same root route -- when a flow is selected we land
    // on /flow/:id and this item stays active.
    { id: "flows", to: `/?${qs}`, icon: <IconFlows />, label: "Flows" },
    { id: "graph", to: `/corrie?${qs}`, icon: <IconGraph />, label: "Graph · G" },
    { id: "diff", to: `/diff/?${qs}`, icon: <IconDiff />, label: "Diff · D" },
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
      <button
        type="button"
        className="rail-btn"
        title="Settings"
        onClick={() => {
          // Tweaks toggle is not wired in this build -- hint to the user
          // until the Tweaks panel is implemented.
          const html = document.documentElement;
          const cur = html.getAttribute("data-accent") || "magenta";
          const next = cur === "magenta" ? "cyan" : cur === "cyan" ? "amber" : cur === "amber" ? "green" : "magenta";
          html.setAttribute("data-accent", next);
          localStorage.setItem("tulip.accent", next);
        }}
      >
        <IconSettings />
      </button>
    </div>
  );
}
