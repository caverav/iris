import { useSearchParams } from "react-router-dom";
import { useState } from "react";
import { Buffer } from "buffer";

import { FullFlow } from "../types";

import ReactDiffViewer from "react-diff-viewer";

import { hexy } from "hexy";

import { FIRST_DIFF_KEY, SECOND_DIFF_KEY } from "../const";
import { useGetFlowQuery } from "../api";
import classNames from "classnames";

function DiffPane(flow1: string, flow2: string, key: number) {
  return (
    <div key={key} style={{ borderBottom: "1px solid var(--line)" }}>
      <ReactDiffViewer
        oldValue={flow1}
        newValue={flow2}
        splitView={true}
        showDiffOnly={false}
        useDarkTheme={true}
        hideLineNumbers={true}
        styles={{
          line: { wordBreak: "break-word" },
          variables: {
            dark: {
              diffViewerBackground: "var(--bg)",
              diffViewerColor: "var(--ink)",
              gutterBackground: "var(--bg-1)",
              gutterColor: "var(--ink-faint)",
              addedBackground: "color-mix(in oklab, var(--ok) 10%, transparent)",
              addedColor: "var(--ink)",
              removedBackground: "color-mix(in oklab, var(--danger) 10%, transparent)",
              removedColor: "var(--ink)",
              wordAddedBackground: "color-mix(in oklab, var(--ok) 35%, transparent)",
              wordRemovedBackground: "color-mix(in oklab, var(--danger) 35%, transparent)",
              addedGutterBackground: "var(--bg-1)",
              removedGutterBackground: "var(--bg-1)",
              gutterBackgroundDark: "var(--bg)",
              highlightBackground: "var(--bg-2)",
              highlightGutterBackground: "var(--bg-2)",
              codeFoldGutterBackground: "var(--bg-1)",
              codeFoldBackground: "var(--bg-1)",
              emptyLineBackground: "var(--bg)",
              codeFoldContentColor: "var(--ink-muted)",
              diffViewerTitleBackground: "var(--bg-1)",
              diffViewerTitleColor: "var(--ink)",
              diffViewerTitleBorderColor: "var(--line)",
            },
          },
        }}
      />
    </div>
  );
}

function isASCII(str: string) {
  return /^[\x00-\x7F]*$/.test(str);
}

const displayOptions = ["plain", "hex"] as const;
type DisplayOption = typeof displayOptions[number];

const deriveDisplayMode = (
  firstFlow?: FullFlow,
  secondFlow?: FullFlow,
): DisplayOption => {
  if (firstFlow && secondFlow) {
    for (
      let i = 0;
      i < Math.min(firstFlow.flow.length, secondFlow.flow.length);
      i++
    ) {
      if (!isASCII(firstFlow.flow[0].flow[i].data) || !isASCII(secondFlow.flow[0].flow[i].data)) {
        return "hex";
      }
    }
  }
  return "plain";
};

export function DiffView() {
  const [searchParams] = useSearchParams();
  const firstFlowParam = searchParams.get(FIRST_DIFF_KEY);
  const firstFlowId = firstFlowParam?.split(":")[0];
  const firstFlowRepr = parseInt(firstFlowParam?.split(":")[1] ?? "0");
  const secondFlowParam = searchParams.get(SECOND_DIFF_KEY);
  const secondFlowId = secondFlowParam?.split(":")[0];
  const secondFlowRepr = parseInt(secondFlowParam?.split(":")[1] ?? "0");

  const { data: firstFlow, isLoading: firstFlowLoading, isError: firstFlowError } = useGetFlowQuery(
    firstFlowId!,
    { skip: !firstFlowId },
  );
  const { data: secondFlow, isLoading: secondFlowLoading, isError: secondFlowError } = useGetFlowQuery(
    secondFlowId!,
    { skip: !secondFlowId },
  );

  const [displayOption, setDisplayOption] = useState<DisplayOption>(
    deriveDisplayMode(firstFlow, secondFlow),
  );

  if (firstFlowError || secondFlowError) {
    return <div className="detail-body" style={{ padding: 24, color: "var(--danger)" }}>Invalid flow id</div>;
  }
  if (firstFlowLoading || secondFlowLoading || !firstFlow || !secondFlow) {
    return <div className="detail-body" style={{ padding: 24, color: "var(--ink-muted)" }}>Loading...</div>;
  }

  const firstLen = firstFlow.flow[firstFlowRepr].flow.length;
  const secondLen = secondFlow.flow[secondFlowRepr].flow.length;
  const paneCount = Math.min(firstLen, secondLen);

  return (
    <>
      <div className="diff-head">
        <span
          style={{
            fontSize: 10,
            color: "var(--ink-faint)",
            letterSpacing: "0.18em",
            textTransform: "uppercase",
          }}
        >
          diff
        </span>
        <div className="ctl">
          <span style={{ color: "var(--ink-faint)" }}>A</span>{" "}
          <b style={{ marginLeft: 4 }}>{firstFlowId?.slice(0, 12)}</b>
        </div>
        <div className="ctl">
          <span style={{ color: "var(--ink-faint)" }}>B</span>{" "}
          <b style={{ marginLeft: 4 }}>{secondFlowId?.slice(0, 12)}</b>
        </div>
        <div style={{ flex: 1 }} />
        <div className="seg">
          {displayOptions.map((opt) => (
            <button
              key={opt}
              className={classNames({ on: displayOption === opt })}
              onClick={() => setDisplayOption(opt)}
            >
              {opt}
            </button>
          ))}
        </div>
      </div>

      <div className="diff-stage">
        {displayOption === "plain" &&
          Array.from({ length: paneCount }, (_, i) =>
            DiffPane(
              firstFlow.flow[firstFlowRepr].flow[i].data,
              secondFlow.flow[secondFlowRepr].flow[i].data,
              i,
            ),
          )}

        {displayOption === "hex" &&
          Array.from({ length: paneCount }, (_, i) =>
            DiffPane(
              hexy(Buffer.from(firstFlow.flow[firstFlowRepr].flow[i].b64, "base64"), { format: "twos" }),
              hexy(Buffer.from(secondFlow.flow[secondFlowRepr].flow[i].b64, "base64"), { format: "twos" }),
              i,
            ),
          )}
      </div>
    </>
  );
}
