/* ⌘K command palette. Navigate + filter + action surface.
   Kept light on implementation: arrow-key selection, fuzzy "includes"
   filter on labels, Enter to dispatch. Extend `all` when new actions
   land. */
import { useEffect, useMemo, useRef, useState } from "react";
import {
  IconBolt,
  IconClose,
  IconDiff,
  IconFilter,
  IconFlows,
  IconGraph,
  IconHeart,
  IconHome,
  IconSearch,
} from "./icons";

type NavId = "home" | "flows" | "graph" | "diff";
type Section = "nav" | "action" | "search";

interface PaletteItem {
  s: Section;
  id: string;
  label: string;
  icon: JSX.Element;
  hint: string;
  nav?: NavId;
}

interface Props {
  open: boolean;
  onClose: () => void;
  onNavigate: (view: NavId) => void;
}

const ALL: PaletteItem[] = [
  { s: "nav", id: "home", label: "Go to home", icon: <IconHome />, hint: "", nav: "home" },
  { s: "nav", id: "flows", label: "Go to flows", icon: <IconFlows />, hint: "", nav: "flows" },
  { s: "nav", id: "graph", label: "Go to correlation graph", icon: <IconGraph />, hint: "g", nav: "graph" },
  { s: "nav", id: "diff", label: "Go to diff", icon: <IconDiff />, hint: "d", nav: "diff" },
  { s: "action", id: "refresh", label: "Refresh flows", icon: <IconBolt />, hint: "r" },
  { s: "action", id: "last5", label: "Filter: last 5 ticks", icon: <IconBolt />, hint: "a" },
  { s: "action", id: "clear", label: "Clear time selection", icon: <IconClose />, hint: "c" },
  { s: "action", id: "star", label: "Star selected flow", icon: <IconHeart />, hint: "x" },
  { s: "search", id: "tag-out", label: "Filter by tag: flag-out", icon: <IconFilter />, hint: "o" },
  { s: "search", id: "tag-in", label: "Filter by tag: flag-in", icon: <IconFilter />, hint: "i" },
  { s: "search", id: "tag-st", label: "Filter by tag: starred", icon: <IconFilter />, hint: "t" },
];

const SECTION_TITLES: Record<Section, string> = {
  nav: "Navigate",
  action: "Actions",
  search: "Search & filter",
};

export function CommandPalette({ open, onClose, onNavigate }: Props) {
  const [q, setQ] = useState("");
  const [sel, setSel] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (open) {
      setQ("");
      setSel(0);
      const t = setTimeout(() => inputRef.current?.focus(), 30);
      return () => clearTimeout(t);
    }
  }, [open]);

  const filtered = useMemo(
    () => ALL.filter((x) => !q || x.label.toLowerCase().includes(q.toLowerCase())),
    [q],
  );

  const onKey = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === "Escape") {
      onClose();
      return;
    }
    if (e.key === "ArrowDown") {
      setSel((s) => Math.min(filtered.length - 1, s + 1));
      e.preventDefault();
    }
    if (e.key === "ArrowUp") {
      setSel((s) => Math.max(0, s - 1));
      e.preventDefault();
    }
    if (e.key === "Enter") {
      const item = filtered[sel];
      if (item) dispatch(item);
    }
  };

  const dispatch = (item: PaletteItem) => {
    if (item.s === "nav" && item.nav) {
      onNavigate(item.nav);
    }
    // Actions (star/refresh/etc.) would hook into their respective pages'
    // keyboard handlers; the palette is primarily a nav + discovery surface.
    onClose();
  };

  if (!open) return null;

  const sections: Section[] = ["nav", "action", "search"];

  return (
    <div className={`cmdk-backdrop open`} onClick={onClose} role="dialog" aria-modal="true">
      <div className="cmdk" onClick={(e) => e.stopPropagation()}>
        <div className="cmdk-input">
          <IconSearch size={14} />
          <input
            ref={inputRef}
            placeholder="Jump to view, run action, filter by tag…"
            value={q}
            onChange={(e) => {
              setQ(e.target.value);
              setSel(0);
            }}
            onKeyDown={onKey}
          />
          <span className="esc">esc</span>
        </div>
        <div className="cmdk-list">
          {sections.map((section) => {
            const items = filtered.filter((x) => x.s === section);
            if (!items.length) return null;
            return (
              <div key={section}>
                <div className="cmdk-section">{SECTION_TITLES[section]}</div>
                {items.map((it) => {
                  const absIdx = filtered.indexOf(it);
                  return (
                    <div
                      key={it.id}
                      className={`cmdk-item ${absIdx === sel ? "active" : ""}`}
                      onMouseEnter={() => setSel(absIdx)}
                      onClick={() => dispatch(it)}
                    >
                      {it.icon}
                      <span>{it.label}</span>
                      <span className="hint">{it.hint || "↵"}</span>
                    </div>
                  );
                })}
              </div>
            );
          })}
          {filtered.length === 0 && (
            <div className="cmdk-section">No matches for "{q}"</div>
          )}
        </div>
      </div>
    </div>
  );
}
