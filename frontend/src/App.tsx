import {
  BrowserRouter,
  Routes,
  Route,
  Outlet,
  useLocation,
  useNavigate,
  useSearchParams,
  Link,
} from "react-router-dom";
import { Suspense, useEffect, useMemo, useRef, useState } from "react";
import { useHotkeys } from "react-hotkeys-hook";

import "./App.css";
import { Header } from "./components/Header";
import { Home } from "./pages/Home";
import { FlowList } from "./components/FlowList";
import { FlowView } from "./pages/FlowView";
import { DiffView } from "./pages/DiffView";
import { Corrie } from "./components/Corrie";
import { Rail } from "./components/Rail";
import { StatusBar } from "./components/StatusBar";
import { CommandPalette } from "./components/CommandPalette";

/* Dark-first: the app applies the `dark` class and tweak data attributes on
   <html> at mount. Persisted tweaks (accent / density / tag style) live in
   localStorage so the look survives reloads. */
function useDarkMode() {
  useEffect(() => {
    document.documentElement.classList.add("dark");
    const read = (k: string, d: string) => localStorage.getItem(k) || d;
    document.documentElement.setAttribute("data-accent", read("iris.accent", "magenta"));
    document.documentElement.setAttribute("data-density", read("iris.density", "dense"));
    document.documentElement.setAttribute("data-tag-style", read("iris.tagStyle", "dot"));
  }, []);
}

function App() {
  useDarkMode();
  useHotkeys("esc", () => (document.activeElement as HTMLElement).blur(), {
    enableOnFormTags: true,
  });

  return (
    <BrowserRouter>
      <Routes>
        <Route path="/" element={<Shell />}>
          <Route index element={<Home />} />
          <Route
            path="flow/:id"
            element={
              <Suspense>
                <FlowView />
              </Suspense>
            }
          />
          <Route
            path="diff/:id"
            element={
              <Suspense>
                <DiffView />
              </Suspense>
            }
          />
          <Route
            path="corrie/"
            element={
              <Suspense>
                <Corrie />
              </Suspense>
            }
          />
        </Route>
        <Route path="*" element={<PageNotFound />} />
      </Routes>
    </BrowserRouter>
  );
}

/* The Shell renders the global chrome - header, left rail, status bar,
   command palette - and slots view-specific content into the main area.
   The FlowList lives next to the flow detail view only when a route that
   "owns" the flow list is active (root and /flow/:id). */
function Shell() {
  const [paletteOpen, setPaletteOpen] = useState(false);
  const location = useLocation();
  const [searchParams] = useSearchParams();
  const navigate = useNavigate();

  // Which high-level view are we on? Used to highlight the rail + pick the
  // main-area grid template.
  const view = useMemo<"home" | "flows" | "graph" | "diff">(() => {
    const p = location.pathname;
    if (p.startsWith("/corrie")) return "graph";
    if (p.startsWith("/diff")) return "diff";
    if (p.startsWith("/flow")) return "flows";
    return "home";
  }, [location.pathname]);

  // Show the FlowList only when the user is looking at flows (root or a
  // selected flow). Home, graph, and diff take the full main column.
  const showFlowList = view === "home" || view === "flows";

  // Main grid template: 48px rail + (360px list when visible) + 1fr content.
  const mainTemplate = showFlowList
    ? "48px 360px 1fr"
    : "48px 1fr";

  useHotkeys(
    "mod+k",
    (e) => {
      e.preventDefault();
      setPaletteOpen(true);
    },
    { enableOnFormTags: true },
  );
  useHotkeys("/", (e) => {
    e.preventDefault();
    setPaletteOpen(true);
  });
  useHotkeys("esc", () => setPaletteOpen(false), { enableOnFormTags: true });

  return (
    <div className="app" data-screen-label={`Iris . ${view}`}>
      <div className="header-area">
        <div className="header">
          <Header onOpenPalette={() => setPaletteOpen(true)} />
        </div>
      </div>

      <div className="main" style={{ gridTemplateColumns: mainTemplate }}>
        <Rail active={view} />
        {showFlowList && (
          <Suspense>
            <FlowList />
          </Suspense>
        )}
        <div className="mid">
          <Outlet />
        </div>
      </div>

      <StatusBar view={view} />

      <CommandPalette
        open={paletteOpen}
        onClose={() => setPaletteOpen(false)}
        onNavigate={(target) => {
          if (target === "home") navigate(`/?${searchParams}`);
          if (target === "flows") navigate(`/?${searchParams}`);
          if (target === "graph") navigate(`/corrie?${searchParams}`);
          if (target === "diff") navigate(`/diff/?${searchParams}`);
        }}
      />
    </div>
  );
}

function PageNotFound() {
  return (
    <div className="app">
      <div className="header-area" />
      <div className="main" style={{ gridTemplateColumns: "48px 1fr" }}>
        <div className="rail" />
        <div className="home">
          <div className="home-inner">
            <h1>
              <b>404</b>
            </h1>
            <div className="tagline">lost in the flow</div>
            <div className="cta">
              <Link className="ctl accent" to="/">
                return home
              </Link>
            </div>
          </div>
        </div>
      </div>
      <div className="status" />
    </div>
  );
}

export default App;
