import { Suspense, useState } from "react";
import { useHotkeys } from "react-hotkeys-hook";
import {
  Link,
  useParams,
  useSearchParams,
  useNavigate,
} from "react-router-dom";

import {
  END_FILTER_KEY,
  SERVICE_FILTER_KEY,
  START_FILTER_KEY,
  TEXT_FILTER_KEY,
  FIRST_DIFF_KEY,
  SECOND_DIFF_KEY,
  SERVICE_REFETCH_INTERVAL_MS,
  REPR_ID_KEY,
} from "../const";
import { useGetServicesQuery } from "../api";
import { getTickStuff } from "../tick";
import {
  IconCmdK,
  IconDiff,
  IconGraph,
  IconSearch,
  IrisMark,
} from "./icons";

/* --- service selector -------------------------------------------------- */

function ServiceSelector() {
  const { data: services } = useGetServicesQuery(undefined, {
    pollingInterval: SERVICE_REFETCH_INTERVAL_MS,
  });
  const serviceList = [
    { ip: "", port: 0, name: "all services" },
    ...(services || []),
  ];
  const [searchParams, setSearchParams] = useSearchParams();
  return (
    <select
      className="num-input"
      style={{ width: 140, textAlign: "left", paddingRight: 22 }}
      value={searchParams.get(SERVICE_FILTER_KEY) ?? ""}
      onChange={(event) => {
        const v = event.target.value;
        if (v && v !== "all services") {
          searchParams.set(SERVICE_FILTER_KEY, v);
        } else {
          searchParams.delete(SERVICE_FILTER_KEY);
        }
        setSearchParams(searchParams);
      }}
    >
      {serviceList.map((service) => (
        <option key={service.name} value={service.name}>
          {service.name}
        </option>
      ))}
    </select>
  );
}

/* --- search (regex filter) --------------------------------------------- */

function SearchBox({ onActivate }: { onActivate?: () => void }) {
  const [searchParams, setSearchParams] = useSearchParams();
  useHotkeys("s", (e) => {
    const el = document.getElementById("search") as HTMLInputElement | null;
    el?.focus();
    el?.select();
    e.preventDefault();
  });
  return (
    <div className="search" onClick={onActivate}>
      <IconSearch size={12} />
      <input
        type="text"
        id="search"
        placeholder="regex · type to filter flows"
        value={searchParams.get(TEXT_FILTER_KEY) || ""}
        onChange={(event) => {
          const v = event.target.value;
          if (v) {
            searchParams.set(TEXT_FILTER_KEY, v);
          } else {
            searchParams.delete(TEXT_FILTER_KEY);
          }
          setSearchParams(searchParams);
        }}
      />
      <span className="kbd">s</span>
    </div>
  );
}

/* --- tick range inputs -------------------------------------------------- */

function TickRangeInputs() {
  const { startTickParam, endTickParam, setTimeParam } = getTickStuff();
  return (
    <div style={{ display: "flex", alignItems: "center", gap: 4 }}>
      <span
        style={{
          fontSize: 9,
          color: "var(--ink-faint)",
          letterSpacing: "0.2em",
          textTransform: "uppercase",
          marginRight: 4,
        }}
      >
        tick
      </span>
      <input
        className="num-input"
        id="startdateselection"
        type="number"
        placeholder="from"
        value={startTickParam}
        onChange={(e) =>
          setTimeParam(
            e.target.value === "" ? null : parseInt(e.target.value),
            START_FILTER_KEY,
          )
        }
      />
      <span style={{ color: "var(--ink-faint)" }}>..</span>
      <input
        className="num-input"
        id="enddateselection"
        type="number"
        placeholder="to"
        value={endTickParam}
        onChange={(e) =>
          setTimeParam(
            e.target.value === "" ? null : parseInt(e.target.value),
            END_FILTER_KEY,
          )
        }
      />
    </div>
  );
}

/* --- diff slot inputs + diff action ------------------------------------ */

function FirstDiff() {
  const params = useParams();
  const [searchParams, setSearchParams] = useSearchParams();
  const [firstFlow, setFirstFlow] = useState<string>(
    searchParams.get(FIRST_DIFF_KEY) ?? "",
  );

  function setFirstDiffFlow() {
    const textFilter = params.id;
    const reprId = searchParams.get(REPR_ID_KEY);
    const reprIdSlug = reprId ? `${textFilter}:${reprId}` : `${textFilter}`;
    if (textFilter) {
      searchParams.set(FIRST_DIFF_KEY, reprIdSlug);
      setFirstFlow(reprIdSlug);
    } else {
      searchParams.delete(FIRST_DIFF_KEY);
      setFirstFlow("");
    }
    setSearchParams(searchParams);
  }

  useHotkeys("f", () => setFirstDiffFlow());

  return (
    <input
      type="text"
      className="num-input"
      style={{ width: 150, textAlign: "left", paddingLeft: 8 }}
      placeholder="first · F"
      readOnly
      value={firstFlow}
      onClick={() => setFirstDiffFlow()}
      onContextMenu={(event) => {
        searchParams.delete(FIRST_DIFF_KEY);
        setFirstFlow("");
        setSearchParams(searchParams);
        event.preventDefault();
      }}
    />
  );
}

function SecondDiff() {
  const params = useParams();
  const [searchParams, setSearchParams] = useSearchParams();
  const [secondFlow, setSecondFlow] = useState<string>(
    searchParams.get(SECOND_DIFF_KEY) ?? "",
  );

  function setSecondDiffFlow() {
    const textFilter = params.id;
    const reprId = searchParams.get(REPR_ID_KEY);
    const reprIdSlug = reprId ? `${textFilter}:${reprId}` : `${textFilter}`;
    if (textFilter) {
      searchParams.set(SECOND_DIFF_KEY, reprIdSlug);
      setSecondFlow(reprIdSlug);
    } else {
      searchParams.delete(SECOND_DIFF_KEY);
      setSecondFlow("");
    }
    setSearchParams(searchParams);
  }

  useHotkeys("e", () => setSecondDiffFlow());

  return (
    <input
      type="text"
      className="num-input"
      style={{ width: 150, textAlign: "left", paddingLeft: 8 }}
      placeholder="second · E"
      readOnly
      value={secondFlow}
      onClick={() => setSecondDiffFlow()}
      onContextMenu={(event) => {
        searchParams.delete(SECOND_DIFF_KEY);
        setSecondFlow("");
        setSearchParams(searchParams);
        event.preventDefault();
      }}
    />
  );
}

function DiffButton() {
  const params = useParams();
  const [searchParams] = useSearchParams();
  const navigate = useNavigate();

  function navigateToDiff() {
    navigate(`/diff/${params.id ?? ""}?${searchParams}`, { replace: true });
  }

  useHotkeys("d", () => navigateToDiff());

  return (
    <button className="ctl accent" onClick={navigateToDiff}>
      <IconDiff size={12} />
      <span>diff</span>
      <kbd>d</kbd>
    </button>
  );
}

/* --- tick badge --------------------------------------------------------- */

function TickBadge({ tick }: { tick: number }) {
  return (
    <div className="tick-badge" title="Current tick">
      <span className="pulse" />
      <div>
        <small>current tick</small>
        <b>{String(tick).padStart(4, "0")}</b>
      </div>
    </div>
  );
}

/* --- header shell ------------------------------------------------------- */

interface HeaderProps {
  onOpenPalette: () => void;
}

export function Header({ onOpenPalette }: HeaderProps) {
  const { currentTick, setToLastnTicks, setTimeParam } = getTickStuff();
  const [searchParams] = useSearchParams();
  const navigate = useNavigate();

  useHotkeys("g", () =>
    navigate(`/corrie?${searchParams}`, { replace: true }),
  );
  useHotkeys("a", () => setToLastnTicks(5));
  useHotkeys("c", () => {
    const a = document.getElementById("startdateselection") as HTMLInputElement | null;
    const b = document.getElementById("enddateselection") as HTMLInputElement | null;
    if (a) a.value = "";
    if (b) b.value = "";
    setTimeParam(null, START_FILTER_KEY);
    setTimeParam(null, END_FILTER_KEY);
  });

  return (
    <>
      <Link className="brand" to={`/?${searchParams}`} aria-label="Iris home">
        <IrisMark className="brand-mark" size={22} />
        <div className="brand-name">
          <b>iris</b>
          <small>a/d scope</small>
        </div>
      </Link>

      <SearchBox />

      <button type="button" className="ctl" onClick={onOpenPalette}>
        <IconCmdK size={12} />
        <span>command</span>
        <kbd>⌘K</kbd>
      </button>

      <div className="sep" />

      <Suspense>
        <ServiceSelector />
      </Suspense>

      <TickRangeInputs />

      <button className="ctl" onClick={() => setToLastnTicks(5)}>
        last 5
        <kbd>a</kbd>
      </button>

      <div className="sep" />

      <Link className="ctl" to={`/corrie?${searchParams}`}>
        <IconGraph size={12} />
        <span>graph</span>
        <kbd>g</kbd>
      </Link>

      <div style={{ flex: 1 }} />

      <FirstDiff />
      <SecondDiff />
      <Suspense>
        <DiffButton />
      </Suspense>

      <div className="sep" />

      <TickBadge tick={currentTick} />
    </>
  );
}
