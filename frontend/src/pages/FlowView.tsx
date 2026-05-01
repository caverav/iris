import { useSearchParams, useParams, useNavigate } from "react-router-dom";
import React, { useEffect, useState } from "react";
import { useHotkeys } from "react-hotkeys-hook";
import { FlowData, FullFlow } from "../types";
import { Buffer } from "buffer";
import {
  TEXT_FILTER_KEY,
  MAX_LENGTH_FOR_HIGHLIGHT,
  API_BASE_PATH,
  REPR_ID_KEY,
  FIRST_DIFF_KEY,
  SECOND_DIFF_KEY,
} from "../const";
import { format } from "date-fns";
import { hexy } from "hexy";
import classNames from "classnames";
import { useCopy } from "../hooks/useCopy";
import { Tag } from "../components/Tag";
import {
  useGetFlowQuery,
  useGetServicesQuery,
  useLazyToFullPythonRequestQuery,
  useLazyToPwnToolsQuery,
  useToSinglePythonRequestQuery,
  useGetFlagRegexQuery,
} from "../api";
import { getTickStuff } from "../tick";
import escapeStringRegexp from "escape-string-regexp";
import {
  IconCopy,
  IconDownload,
  IconShield,
} from "../components/icons";

/* --- helpers ------------------------------------------------------------ */

function formatIP(ip: string) {
  return ip.includes(":") ? `[${ip}]` : ip;
}

function detectType(flow: FlowData) {
  const firstLine = flow.data.split("\n")[0];
  if (firstLine.includes("HTTP")) return "Web";
  return "Plain";
}

function getFlowBody(flow: FlowData, flowType: string): [string, Buffer] | null {
  if (flowType === "Web") {
    const contentType = flow.data.match(/Content-Type: ([^\s;]+)/im)?.[1];
    if (contentType) {
      const body = Buffer.from(flow.b64, "base64").subarray(
        flow.data.indexOf("\r\n\r\n") + 4,
      );
      return [contentType, body];
    }
  }
  return null;
}

function highlightText(flowText: string, search_string: string, flag_string: string) {
  if (flowText.length > MAX_LENGTH_FOR_HIGHLIGHT || (flag_string === "" && search_string === "")) {
    return flowText;
  }
  try {
    const searchClasses = "hl-search";
    const flagClasses = "hl-flag";

    // @ts-ignore
    const flagMatches: [number, number][] =
      flag_string === ""
        ? []
        // @ts-ignore
        : [...flowText.matchAll(new RegExp(flag_string, "g"))].map((x) => [x.index, x.index + x[0].length]);
    // @ts-ignore
    const searchMatches: [number, number][] =
      search_string === ""
        ? []
        // @ts-ignore
        : [...flowText.matchAll(new RegExp(search_string, "gi"))].map((x) => [x.index, x.index + x[0].length]);

    const parts: React.ReactNode[] = [];
    let currentIndex = 0, flagMatchIndex = 0, searchMatchIndex = 0;
    while (true) {
      let isSearchMatch: boolean | null = null;
      if (flagMatchIndex < flagMatches.length && searchMatchIndex < searchMatches.length) {
        isSearchMatch = searchMatches[searchMatchIndex][0] <= flagMatches[flagMatchIndex][0];
      } else if (searchMatchIndex < searchMatches.length) {
        isSearchMatch = true;
      } else if (flagMatchIndex < flagMatches.length) {
        isSearchMatch = false;
      }
      const match = isSearchMatch === null ? null : isSearchMatch ? searchMatches[searchMatchIndex] : flagMatches[flagMatchIndex];

      if (match === null) {
        parts.push(<span key={currentIndex}>{flowText.slice(currentIndex)}</span>);
        break;
      }
      if (currentIndex !== match[0]) {
        parts.push(<span key={currentIndex}>{flowText.slice(currentIndex, match[0])}</span>);
      }
      parts.push(
        <span key={match[0]} className={isSearchMatch ? searchClasses : flagClasses}>
          {flowText.slice(match[0], match[1])}
        </span>,
      );
      currentIndex = match[1];
      while (flagMatchIndex < flagMatches.length && flagMatches[flagMatchIndex][1] <= currentIndex) flagMatchIndex++;
      if (flagMatchIndex < flagMatches.length && flagMatches[flagMatchIndex][0] < currentIndex) flagMatches[flagMatchIndex][0] = currentIndex;
      while (searchMatchIndex < searchMatches.length && searchMatches[searchMatchIndex][1] <= currentIndex) searchMatchIndex++;
      if (searchMatchIndex < searchMatches.length && searchMatches[searchMatchIndex][0] < currentIndex) searchMatches[searchMatchIndex][0] = currentIndex;
    }
    return <span>{parts}</span>;
  } catch (error) {
    console.error(error);
    return flowText;
  }
}

/* --- message body variants --------------------------------------------- */

function HexFlow({ flow }: { flow: FlowData }) {
  const hex = hexy(Buffer.from(flow.b64, "base64"), { format: "twos" });
  return <pre>{hex}</pre>;
}

function TextFlow({ flow }: { flow: FlowData }) {
  const [searchParams] = useSearchParams();
  const text_filter = searchParams.get(TEXT_FILTER_KEY);
  const { data: flag_regex } = useGetFlagRegexQuery();
  const text = highlightText(flow.data, text_filter ?? "", flag_regex ?? "");
  return <pre>{text}</pre>;
}

function WebFlow({ flow }: { flow: FlowData }) {
  const data = flow.data;
  const [header, ...rest] = data.split("\r\n\r\n");
  const http_content = rest.join("\r\n\r\n");
  const Hack = "iframe" as any;
  return (
    <>
      <pre>{header}</pre>
      <div style={{ padding: "0 14px 14px", borderTop: "1px solid var(--line)" }}>
        <Hack
          srcDoc={http_content}
          sandbox=""
          height={300}
          csp="default-src none"
          style={{ width: "100%", background: "var(--bg-2)", borderRadius: 4 }}
        />
      </div>
    </>
  );
}

function PythonRequestFlow({
  full_flow,
  flow,
  item_index,
}: {
  full_flow: FullFlow;
  flow: FlowData;
  item_index: number;
}) {
  const { data } = useToSinglePythonRequestQuery({
    body: flow.b64,
    id: full_flow.id,
    item_index,
    tokenize: true,
  });
  return <pre>{data}</pre>;
}

/* --- a single message (request or response) ---------------------------- */

interface FlowProps {
  full_flow: FullFlow;
  flow: FlowData;
  flow_item_index: number;
  delta_time: number;
  id: string;
}

function Message({ full_flow, flow, flow_item_index, delta_time, id }: FlowProps) {
  const hms = format(new Date(flow.time), "HH:mm:ss");
  const ms = format(new Date(flow.time), ".SSS");

  const displayOptions = flow.from === "s"
    ? ["Plain", "Hex", "Web"]
    : ["Plain", "Hex", "PythonRequest"];

  const [displayOption, setDisplayOption] = useState("Plain");
  const flowType = detectType(flow);
  const flowBody = getFlowBody(flow, flowType);

  const downloadBlob = (body: Uint8Array | Buffer, contentType: string, filename: string) => {
    const blob = new Blob([body], { type: contentType });
    const url = window.URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.style.display = "none";
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    window.URL.revokeObjectURL(url);
    a.remove();
  };

  return (
    <div className={`msg from-${flow.from}`} id={id}>
      <div className="msg-head">
        <span className={`dir ${flow.from}`}>{flow.from === "s" ? "<" : ">"}</span>
        <span className="t">
          {hms}
          <span style={{ color: "var(--ink-faint)" }}>{ms}</span>
          <span className="delta">+{delta_time}ms</span>
        </span>
        <div className="spacer" />
        <div className="msg-radio">
          {displayOptions.map((o) => (
            <button
              key={o}
              className={displayOption === o ? "on" : ""}
              onClick={() => setDisplayOption(o)}
            >
              {o === "PythonRequest" ? "python" : o.toLowerCase()}
            </button>
          ))}
        </div>
        <button
          className="mini-btn"
          title="Open in CyberChef"
          onClick={() => {
            window.open(
              "https://gchq.github.io/CyberChef/#input=" +
                encodeURIComponent(flow.b64),
            );
          }}
        >
          open in CC
        </button>
        {flowType === "Web" && flowBody && (
          <button
            className="mini-btn"
            title="Open body in CyberChef"
            onClick={() => {
              window.open(
                "https://gchq.github.io/CyberChef/#input=" +
                  encodeURIComponent(flowBody[1].toString("base64")),
              );
            }}
          >
            body . CC
          </button>
        )}
        <button
          className="mini-btn"
          title="Download"
          onClick={() => {
            downloadBlob(
              Buffer.from(flow.b64, "base64"),
              "application/octet-stream",
              `iris-dl-${id}.dat`,
            );
          }}
        >
          download
        </button>
        {flowType === "Web" && flowBody && (
          <button
            className="mini-btn"
            title="Download body"
            onClick={() => downloadBlob(flowBody[1], flowBody[0].toString(), `iris-dl-${id}.dat`)}
          >
            body . dl
          </button>
        )}
      </div>
      <div className="msg-body">
        {displayOption === "Hex" && <HexFlow flow={flow} />}
        {displayOption === "Plain" && <TextFlow flow={flow} />}
        {displayOption === "Web" && <WebFlow flow={flow} />}
        {displayOption === "PythonRequest" && (
          <PythonRequestFlow flow={flow} full_flow={full_flow} item_index={flow_item_index} />
        )}
      </div>
    </div>
  );
}

/* --- overview card ----------------------------------------------------- */

function FlowOverview({ flow }: { flow: FullFlow }) {
  const [searchParams, setSearchParams] = useSearchParams();
  const { unixTimeToTick } = getTickStuff();
  const { data: services } = useGetServicesQuery();
  const service = services?.find((s) => s.ip === flow.dst_ip && s.port === flow.dst_port)?.name ?? "unknown";
  const hasSignatures = flow.signatures && flow.signatures.length > 0;
  const anyBlocked = hasSignatures && flow.signatures.some((s) => s.action === "blocked");

  return (
    <div className="ov">
      {hasSignatures && (
        <div className={classNames("ov-group", anyBlocked ? "is-danger" : "is-info")}>
          <h4>
            <IconShield size={11} /> suricata . {flow.signatures.length} signature
            {flow.signatures.length === 1 ? "" : "s"} matched
          </h4>
          {flow.signatures.map((sig, idx) => (
            <React.Fragment key={idx}>
              <div className="ov-row">
                <span className="k">message</span>
                <span className="v">{sig.message}</span>
              </div>
              <div className="ov-row">
                <span className="k">rule id</span>
                <span className="v mono">{sig.id}</span>
              </div>
              {sig.tag ? (
                <div className="ov-row">
                  <span className="k">rule tag</span>
                  <span className="v">
                    <Tag tag={`rule:${sig.tag}`} />
                  </span>
                </div>
              ) : null}
              <div className="ov-row">
                <span className="k">action</span>
                <span
                  className="v"
                  style={{ color: sig.action === "blocked" ? "var(--danger)" : "var(--warn)" }}
                >
                  {sig.action}
                </span>
              </div>
            </React.Fragment>
          ))}
        </div>
      )}

      <div className="ov-row" style={{ marginTop: hasSignatures ? 14 : 0 }}>
        <span className="k">source pcap</span>
        <span className="v">
          <a href={`${API_BASE_PATH}/download/?file=${flow.filename}`}>
            {flow.filename}
            <IconDownload size={12} style={{ marginLeft: 4, verticalAlign: "middle" }} />
          </a>
        </span>
      </div>
      <div className="ov-row">
        <span className="k">tags</span>
        <span className="v">
          {flow.tags.length === 0 ? (
            <span style={{ color: "var(--ink-faint)" }}>[]</span>
          ) : (
            flow.tags.map((t) => <Tag key={t} tag={t} />)
          )}
        </span>
      </div>
      <div className="ov-row">
        <span className="k">tick</span>
        <span className="v mono">{unixTimeToTick(flow.time)}</span>
      </div>
      <div className="ov-row">
        <span className="k">service</span>
        <span className="v">{service}</span>
      </div>
      <div className="ov-row">
        <span className="k">flags</span>
        <span className="v">
          {flow.flags.length === 0 ? (
            <span style={{ color: "var(--ink-faint)" }}>[]</span>
          ) : (
            flow.flags.map((query, i) => (
              <button
                key={query + i}
                className="linky"
                onClick={() => {
                  searchParams.set(TEXT_FILTER_KEY, escapeStringRegexp(query));
                  setSearchParams(searchParams);
                }}
              >
                {query}
              </button>
            ))
          )}
        </span>
      </div>
      <div className="ov-row">
        <span className="k">flagids</span>
        <span className="v">
          {flow.flagids.length === 0 ? (
            <span style={{ color: "var(--ink-faint)" }}>[]</span>
          ) : (
            flow.flagids.map((query, i) => (
              <button
                key={query + i}
                className="linky"
                onClick={() => {
                  searchParams.set(TEXT_FILTER_KEY, escapeStringRegexp(query));
                  setSearchParams(searchParams);
                }}
              >
                {query}
              </button>
            ))
          )}
        </span>
      </div>
      <div className="ov-row">
        <span className="k">conn</span>
        <span className="v mono">
          {formatIP(flow.src_ip)}:{flow.src_port} {">"} {formatIP(flow.dst_ip)}:{flow.dst_port}
          <span style={{ color: "var(--ink-faint)", marginLeft: 8 }}>
            . {flow.duration}ms
          </span>
        </span>
      </div>
    </div>
  );
}

/* --- top bar with title + tabs + decoders + pwntools copy -------------- */

interface DetailHeadProps {
  flow: FullFlow;
  reprId: number;
  setReprId: (n: number) => void;
  onCopyPwn: () => void;
  pwnCopyStatusText: string;
  onCopyRequests: () => void;
  requestsCopyStatusText: string;
  onJumpToDiff: () => void;
}

function DetailHead({
  flow,
  reprId,
  setReprId,
  onCopyPwn,
  pwnCopyStatusText,
  onCopyRequests,
  requestsCopyStatusText,
  onJumpToDiff,
}: DetailHeadProps) {
  const { data: services } = useGetServicesQuery();
  const service = services?.find((s) => s.ip === flow.dst_ip && s.port === flow.dst_port)?.name ?? "unknown";

  return (
    <div className="detail-head">
      <div className="title">
        <span className="svc">{service}</span>
        <span className="addr">
          {formatIP(flow.src_ip)}:{flow.src_port}
        </span>
        <span className="arrow">{">"}</span>
        <span className="addr">
          {formatIP(flow.dst_ip)}:{flow.dst_port}
        </span>
      </div>
      <div className="spacer" />

      {flow.flow && flow.flow.length > 1 && (
        <div className="detail-tabs" role="tablist" aria-label="decoders">
          {flow.flow.map((e, i) => (
            <button
              key={i}
              className={classNames("detail-tab", { "is-active": i === reprId })}
              onClick={() => setReprId(i)}
              role="tab"
              aria-selected={i === reprId}
            >
              <span>{e.type}</span>
              {i > 0 && <span className="badge">alt</span>}
            </button>
          ))}
          {reprId > 0 && (
            <button
              className="ctl"
              title="Diff this representation with the base"
              onClick={onJumpToDiff}
            >
              diff
            </button>
          )}
        </div>
      )}

      <button className="ctl accent" onClick={onCopyPwn} style={{ marginLeft: 10 }}>
        <IconCopy size={11} /> {pwnCopyStatusText}
      </button>
      <button className="ctl" onClick={onCopyRequests}>
        <IconCopy size={11} /> {requestsCopyStatusText}
      </button>
    </div>
  );
}

/* --- root -------------------------------------------------------------- */

export function FlowView() {
  const [searchParams, setSearchParams] = useSearchParams();
  const params = useParams();
  const navigate = useNavigate();

  const id = params.id;

  const [reprId, setReprId] = useState(parseInt(searchParams.get(REPR_ID_KEY) ?? "0"));

  const { data: flow, isError, isLoading } = useGetFlowQuery(id!, { skip: id === undefined });

  const [triggerPwnToolsQuery] = useLazyToPwnToolsQuery();
  const [triggerFullPythonRequestQuery] = useLazyToFullPythonRequestQuery();

  async function copyAsPwn() {
    if (flow?.id) {
      const { data } = await triggerPwnToolsQuery(flow.id);
      return data || "";
    }
    return "";
  }
  const { statusText: pwnCopyStatusText, copy: copyPwn } = useCopy({
    getText: copyAsPwn,
    copyStateToText: {
      copied: "copied",
      default: "copy pwntools",
      failed: "failed",
      copying: "generating",
    },
  });

  async function copyAsRequests() {
    if (flow?.id) {
      const { data } = await triggerFullPythonRequestQuery(flow.id);
      return data || "";
    }
    return "";
  }
  const { statusText: requestsCopyStatusText, copy: copyRequests } = useCopy({
    getText: copyAsRequests,
    copyStateToText: {
      copied: "copied",
      default: "copy requests",
      failed: "failed",
      copying: "generating",
    },
  });

  const [currentFlow, setCurrentFlow] = useState<number>(-1);

  useHotkeys("j", () => setCurrentFlow(0));
  useHotkeys("k", () => setCurrentFlow(0));
  useHotkeys(
    "h",
    () => {
      if (currentFlow === 0) {
        const el = document.querySelector(".detail-body");
        if (el) el.scrollTop = 0;
      }
      setCurrentFlow((fi) => Math.max(0, fi - 1));
    },
    [currentFlow],
  );
  useHotkeys(
    "l",
    () => setCurrentFlow((fi) => Math.min((flow?.flow?.length ?? 1) - 1, fi + 1)),
    [currentFlow, flow?.flow?.length],
  );

  useEffect(() => {
    if (currentFlow < 0) return;
    document.getElementById(`${id}-${currentFlow}`)?.scrollIntoView(true);
  }, [currentFlow]);

  useHotkeys(
    "m",
    () => setReprId((ri) => (ri + 1) % (flow?.flow.length ?? 1)),
    [reprId, flow?.flow.length],
  );

  useEffect(() => {
    if (reprId === 0) {
      searchParams.delete(REPR_ID_KEY);
      setSearchParams(searchParams);
      return;
    }
    searchParams.set(REPR_ID_KEY, reprId.toString());
    setSearchParams(searchParams);
  }, [reprId]);

  useEffect(() => {
    if (flow?.flow.length === undefined || flow?.flow.length === 0) return;
    if ((flow?.flow.length - 1) < reprId) setReprId(0);
  }, [flow?.flow.length]);

  if (isError) {
    return (
      <div className="detail-body" style={{ padding: 24, color: "var(--danger)" }}>
        Error while fetching flow
      </div>
    );
  }
  if (isLoading || flow === undefined) {
    return (
      <div className="detail-body" style={{ padding: 24, color: "var(--ink-muted)" }}>
        Loading...
      </div>
    );
  }

  const representation = flow.flow[reprId < flow.flow.length ? reprId : 0];

  const jumpToDiff = () => {
    searchParams.set(FIRST_DIFF_KEY, `${id}`);
    searchParams.set(SECOND_DIFF_KEY, `${id}:${reprId}`);
    navigate(`/diff/${id ?? ""}?${searchParams}`, { replace: true });
  };

  return (
    <>
      <DetailHead
        flow={flow}
        reprId={reprId}
        setReprId={setReprId}
        onCopyPwn={copyPwn}
        pwnCopyStatusText={pwnCopyStatusText}
        onCopyRequests={copyRequests}
        requestsCopyStatusText={requestsCopyStatusText}
        onJumpToDiff={jumpToDiff}
      />

      {/* Parent / child navigation sits above the overview when available. */}
      {(flow.child_id != null || flow.parent_id != null) && (
        <div
          style={{
            display: "flex",
            gap: 8,
            padding: "8px 16px",
            borderBottom: "1px solid var(--line)",
            background: "var(--bg-1)",
          }}
        >
          <button
            className="ctl"
            disabled={flow.parent_id === null}
            onMouseDown={(e) => {
              if (e.button === 1) {
                window.open(`/flow/${flow.parent_id}?${searchParams}`, "_blank");
              } else if (e.button === 0) {
                navigate(`/flow/${flow.parent_id}?${searchParams}`);
              }
            }}
          >
            parent
          </button>
          <button
            className="ctl"
            disabled={flow.child_id === null}
            onMouseDown={(e) => {
              if (e.button === 1) {
                window.open(`/flow/${flow.child_id}?${searchParams}`, "_blank");
              } else if (e.button === 0) {
                navigate(`/flow/${flow.child_id}?${searchParams}`);
              }
            }}
          >
            child
          </button>
        </div>
      )}

      <div className="detail-body">
        <FlowOverview flow={flow} />
        {representation?.flow.map((flow_data, i, a) => {
          const delta_time = a[i].time - (a[i - 1]?.time ?? a[i].time);
          return (
            <Message
              flow={flow_data}
              flow_item_index={i}
              delta_time={delta_time}
              full_flow={flow}
              key={flow.id + "-" + i}
              id={flow.id + "-" + i}
            />
          );
        })}
      </div>
    </>
  );
}
