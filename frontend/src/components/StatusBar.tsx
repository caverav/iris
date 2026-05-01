/* Global status bar pinned to the bottom row of the app shell. Terminal /
   Bloomberg-style footer: connection dot, current view, shortcut hints. */
import { useEffect, useState } from "react";
import { modCombo } from "../utils/platform";

export function StatusBar({ view }: { view: string }) {
  // Heartbeat so the live dot feels alive - purely cosmetic.
  const [hb, setHb] = useState(0);
  useEffect(() => {
    const t = setInterval(() => setHb((n) => (n + 1) % 1000), 1500);
    return () => clearInterval(t);
  }, []);

  return (
    <div className="status">
      <span className="dot" />
      <span>live . ws connected</span>
      <span style={{ color: "var(--ink-ghost)" }}>|</span>
      <span>suricata . rules loaded</span>
      <span style={{ color: "var(--ink-ghost)" }}>|</span>
      <span style={{ color: "var(--ink-muted)" }}>heartbeat . {String(hb).padStart(3, "0")}</span>
      <div className="spacer" />
      <span>
        <kbd>?</kbd> shortcuts
      </span>
      <span>
        <kbd>{modCombo("k")}</kbd> command
      </span>
      <span style={{ color: "var(--ink-muted)" }}>
        view .{" "}
        <b style={{ color: "var(--acc)", fontWeight: 600 }}>{view}</b>
      </span>
    </div>
  );
}
