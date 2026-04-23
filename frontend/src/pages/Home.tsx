import { Link, useSearchParams } from "react-router-dom";
import { IrisMark, IconFlows, IconCmdK } from "../components/icons";

/* Home landing: glowing tulip mark over a radial-gradient canvas, a small
   set of shortcut-reference cards, and two CTAs that map to the two most
   likely next actions (enter flows / open command palette). */

const shortcutCards: Array<{ title: string; rows: Array<[string, string]> }> = [
  {
    title: "Navigate",
    rows: [
      ["j / k", "flow list ↓ / ↑"],
      ["h / l", "flow ↑ / ↓"],
      ["w", "scroll to current"],
      ["s", "focus search"],
      ["esc", "unfocus"],
    ],
  },
  {
    title: "Time",
    rows: [
      ["a", "last 5 ticks"],
      ["c", "clear time"],
      ["r", "refresh"],
    ],
  },
  {
    title: "Flows",
    rows: [
      ["x", "star flow"],
      ["i / o", "flag in / out"],
      ["t", "starred"],
    ],
  },
  {
    title: "Views",
    rows: [
      ["d", "diff"],
      ["g", "graph"],
      ["f / e", "diff slot 1 / 2"],
      ["⌘ K", "command"],
    ],
  },
];

export function Home() {
  const [searchParams] = useSearchParams();
  const qs = searchParams.toString();

  return (
    <div className="home">
      <div className="home-inner">
        <div className="home-mark">
          <IrisMark size={56} />
        </div>
        <h1>
          welcome to <b>iris</b>
        </h1>
        <div className="tagline">attack / defence · flow scope</div>

        <div className="cta">
          {/* No dedicated /flows route -- the root page IS the flow view when
              a selection lands. Clicking "enter flows" wakes the FlowList
              sidebar (already rendered by Shell on /) and leaves focus there. */}
          <Link className="ctl accent" to={`/?${qs}`}>
            <IconFlows size={12} /> enter flows
          </Link>
          <button
            type="button"
            className="ctl"
            onClick={() => {
              // Dispatch a synthetic keydown so Shell's ⌘K handler opens the
              // palette without Home needing to know about the palette state.
              const e = new KeyboardEvent("keydown", {
                key: "k",
                metaKey: true,
                bubbles: true,
              });
              window.dispatchEvent(e);
            }}
          >
            <IconCmdK size={12} /> command palette <kbd>⌘K</kbd>
          </button>
        </div>

        <div className="shortcuts">
          {shortcutCards.map(({ title, rows }) => (
            <div className="sc-card" key={title}>
              <h5>{title}</h5>
              {rows.map(([k, a]) => (
                <div className="sc" key={k}>
                  <kbd>{k}</kbd>
                  <span className="a">{a}</span>
                </div>
              ))}
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}
