import {
  useSearchParams,
  Link,
  useParams,
  useNavigate,
} from "react-router-dom";
import { useState, useRef, useEffect } from "react";
import { useHotkeys } from "react-hotkeys-hook";
import { FetchBaseQueryError } from "@reduxjs/toolkit/query";
import { Flow } from "../types";
import {
  SERVICE_FILTER_KEY,
  TEXT_FILTER_KEY,
  START_FILTER_KEY,
  END_FILTER_KEY,
  FLOW_LIST_REFETCH_INTERVAL_MS,
  FORCE_REFETCH_ON_STAR,
} from "../const";
import { useAppSelector, useAppDispatch } from "../store";
import { toggleFilterTag, toggleTagIntersectMode } from "../store/filter";

import { format } from "date-fns";
import useDebounce from "../hooks/useDebounce";
import { Virtuoso, VirtuosoHandle } from "react-virtuoso";
import classNames from "classnames";
import { Tag } from "./Tag";
import {
  useGetFlowsQuery,
  useGetServicesQuery,
  useGetTagsQuery,
  useStarFlowMutation,
} from "../api";
import {
  IconFilter,
  IconFlows,
  IconHeart,
  IconHeartOutline,
  IconLink,
  IconRefresh,
} from "./icons";

export function FlowList() {
  const [searchParams] = useSearchParams();
  const params = useParams();

  let openedFlowID = params.id;

  const { data: availableTags } = useGetTagsQuery();
  const { data: services } = useGetServicesQuery();

  const filterFlags = useAppSelector((state) => state.filter.filterFlags);
  const filterFlagids = useAppSelector((state) => state.filter.filterFlagids);
  const includeTags = useAppSelector((state) => state.filter.includeTags);
  const excludeTags = useAppSelector((state) => state.filter.excludeTags);
  const tagIntersectionMode = useAppSelector(
    (state) => state.filter.tagIntersectionMode,
  );

  const dispatch = useAppDispatch();

  const [starFlow] = useStarFlowMutation();

  const [flowIndex, setFlowIndex] = useState<number>(0);
  const virtuoso = useRef<VirtuosoHandle>(null);

  const service_name = searchParams.get(SERVICE_FILTER_KEY) ?? "";
  const service = services?.find((s) => s.name == service_name);

  const text_filter = searchParams.get(TEXT_FILTER_KEY) ?? undefined;
  const from_filter = searchParams.get(START_FILTER_KEY) ?? undefined;
  const to_filter = searchParams.get(END_FILTER_KEY) ?? undefined;

  const debounced_text_filter = useDebounce(text_filter, 300);

  const {
    data: flowData,
    error: flowQueryError,
    isLoading,
    isFetching,
    refetch,
    startedTimeStamp,
    fulfilledTimeStamp,
  } = useGetFlowsQuery(
    {
      regex_insensitive: debounced_text_filter,
      ip_dst: service?.ip,
      port_dst: service?.port,
      time_from: from_filter
        ? new Date(parseInt(from_filter)).toISOString()
        : undefined,
      time_to: to_filter ? new Date(parseInt(to_filter)).toISOString() : undefined,
      tags_include: includeTags,
      tags_exclude: excludeTags,
      tag_intersection_mode: tagIntersectionMode,
      flags: filterFlags,
      flagids: filterFlagids,
    },
    {
      refetchOnMountOrArgChange: true,
      pollingInterval: FLOW_LIST_REFETCH_INTERVAL_MS,
    },
  );

  interface FlowQueryError {
    error: string;
  }
  const isFetchBaseQueryError = (error: unknown): error is FetchBaseQueryError =>
    typeof error === "object" && error != null && "status" in error;
  const isFlowQueryError = (error: unknown): error is FlowQueryError =>
    typeof error === "object" && error != null && "error" in error;
  const flowQueryErrorMessage =
    isFetchBaseQueryError(flowQueryError) && isFlowQueryError(flowQueryError.data)
      ? flowQueryError.data.error
      : null;

  let searchMessage: string | null = null;
  if (isFetching) searchMessage = "searching...";
  else if (flowQueryErrorMessage) searchMessage = `error: ${flowQueryErrorMessage}`;
  else if (startedTimeStamp && fulfilledTimeStamp)
    searchMessage = `search ${fulfilledTimeStamp - startedTimeStamp}ms`;

  const transformedFlowData = flowData?.map((flow) => ({
    ...flow,
    service_tag:
      services?.find((s) => s.ip === flow.dst_ip && s.port === flow.dst_port)
        ?.name ?? "unknown",
  }));

  const onHeartHandler = async (flow: Flow) => {
    await starFlow({ id: flow.id, star: !flow.tags.includes("starred") });
    if (FORCE_REFETCH_ON_STAR) refetch();
  };

  const navigate = useNavigate();

  useEffect(() => {
    virtuoso?.current?.scrollIntoView({
      index: flowIndex,
      behavior: "auto",
      done: () => {
        if (transformedFlowData && transformedFlowData[flowIndex ?? 0]) {
          const idAtIndex = transformedFlowData[flowIndex ?? 0].id;
          if (idAtIndex !== openedFlowID) {
            navigate(`/flow/${idAtIndex}?${searchParams}`);
            openedFlowID = idAtIndex;
          }
        }
      },
    });
  }, [flowIndex]);

  const [transformedFlowDataLength, setTransformedFlowDataLength] = useState<number>(0);
  useEffect(() => {
    if (
      transformedFlowData &&
      transformedFlowDataLength != transformedFlowData?.length
    ) {
      setTransformedFlowDataLength(transformedFlowData?.length);
      for (let i = 0; i < transformedFlowData?.length; i++) {
        if (transformedFlowData[i].id === openedFlowID) {
          if (i !== flowIndex) setFlowIndex(i);
          return;
        }
      }
      setFlowIndex(0);
    }
  }, [transformedFlowData]);

  useHotkeys("x", async () => {
    if (transformedFlowData) {
      const flow = transformedFlowData[flowIndex ?? 0];
      await onHeartHandler(flow);
    }
  });

  useHotkeys(
    "j",
    () =>
      setFlowIndex((fi) =>
        Math.min((transformedFlowData?.length ?? 1) - 1, fi + 1),
      ),
    [transformedFlowData?.length],
  );
  useHotkeys("w", () => {
    if (transformedFlowData) {
      const idAtIndex = transformedFlowData[flowIndex ?? 0].id;
      if (idAtIndex != openedFlowID) {
        const flowids = flowData?.map((flow, idx) => [flow.id, idx] as const);
        if (flowids) {
          const found = flowids.filter((el) => el[0] == openedFlowID);
          if (found.length > 0) setFlowIndex(Number(found[0][1]));
        }
      }
    }
  });
  useHotkeys("k", () => setFlowIndex((fi) => Math.max(0, fi - 1)));
  useHotkeys(
    "i",
    () => {
      setShowFilters(true);
      if ((availableTags ?? []).includes("flag-in")) dispatch(toggleFilterTag("flag-in"));
    },
    [availableTags],
  );
  useHotkeys(
    "o",
    () => {
      setShowFilters(true);
      if ((availableTags ?? []).includes("flag-out")) dispatch(toggleFilterTag("flag-out"));
    },
    [availableTags],
  );
  useHotkeys(
    "t",
    () => {
      setShowFilters(true);
      if ((availableTags ?? []).includes("starred")) dispatch(toggleFilterTag("starred"));
    },
    [availableTags],
  );
  useHotkeys("r", () => refetch());

  const [showFilters, setShowFilters] = useState(false);

  const count = transformedFlowData?.length ?? 0;

  return (
    <div className="panel">
      <div className="panel-head">
        <span className="label">
          <IconFlows size={11} /> flows
        </span>
        <span className="count">{count.toLocaleString()}</span>
        {searchMessage && (
          <span
            style={{
              fontSize: 9.5,
              color: "var(--ink-faint)",
              letterSpacing: "0.12em",
              textTransform: "uppercase",
              marginLeft: 4,
            }}
          >
            {searchMessage}
          </span>
        )}
        <div className="spacer" />
        <button
          type="button"
          className={classNames("icon-btn", { "is-active": showFilters })}
          onClick={() => setShowFilters((v) => !v)}
          title={showFilters ? "Close filters" : "Open filters"}
        >
          <IconFilter />
        </button>
        <button
          type="button"
          className="icon-btn"
          title="Refresh (r)"
          onClick={() => refetch()}
        >
          <IconRefresh />
        </button>
      </div>

      {showFilters && (
        <div className="filter-drawer open">
          <div className="filter-head">
            <span className="t">intersection filter</span>
            <button
              className="mode-toggle"
              onClick={() => dispatch(toggleTagIntersectMode())}
            >
              mode: <b>{tagIntersectionMode}</b>
            </button>
          </div>
          <div className="tag-cloud">
            {(availableTags ?? []).map((tag) => (
              <Tag
                key={tag}
                tag={tag}
                disabled={!includeTags.includes(tag)}
                excluded={excludeTags.includes(tag)}
                onClick={() => dispatch(toggleFilterTag(tag))}
              />
            ))}
          </div>
        </div>
      )}

      <Virtuoso
        className={classNames("flow-list", { "sidebar-loading": isLoading })}
        data={transformedFlowData}
        ref={virtuoso}
        initialTopMostItemIndex={flowIndex}
        itemContent={(index, flow) => (
          <Link
            to={`/flow/${flow.id}?${searchParams}`}
            onClick={() => setFlowIndex(index)}
            key={flow.id}
          >
            <FlowListEntry
              flow={flow}
              isActive={flow.id === openedFlowID}
              onHeartClick={onHeartHandler}
            />
          </Link>
        )}
      />
    </div>
  );
}

interface FlowListEntryProps {
  flow: Flow;
  isActive: boolean;
  onHeartClick: (flow: Flow) => void;
}

function FlowListEntry({ flow, isActive, onHeartClick }: FlowListEntryProps) {
  const hms = format(new Date(flow.time), "HH:mm:ss");
  const ms = format(new Date(flow.time), ".SSS");

  const [isStarred, setStarred] = useState(flow.tags.includes("starred"));
  const isBlocked = flow.tags.includes("blocked");
  const isLinked = flow.child_id != null || flow.parent_id != null;

  const filtered_tag_list = flow.tags.filter((t) => t !== "starred");

  return (
    <div
      className={classNames("flow-row", {
        "is-active": isActive,
        "is-blocked": isBlocked,
      })}
    >
      <div
        className={classNames("flow-star", { "is-starred": isStarred })}
        onClick={(e) => {
          e.preventDefault();
          e.stopPropagation();
          setStarred(!isStarred);
          onHeartClick(flow);
        }}
      >
        {isStarred ? <IconHeart /> : <IconHeartOutline />}
      </div>
      <div className="flow-link-ind">
        {isLinked ? <IconLink /> : null}
      </div>
      <div className="flow-main">
        <div className="flow-top">
          <span className="flow-service">{flow.service_tag}</span>
          <span className="flow-port">:{flow.dst_port}</span>
          <span className="flow-time">
            {hms}
            <span className="ms">{ms}</span>
          </span>
        </div>
        <div className="flow-tags">
          {filtered_tag_list.map((tag) => (
            <Tag key={tag} tag={tag} />
          ))}
        </div>
      </div>
      <div className="flow-meta">
        <span
          className={classNames("duration", {
            slow: flow.duration > 10000,
          })}
        >
          {flow.duration > 10000 ? ">10s" : `${flow.duration}ms`}
        </span>
        <span className="bytes">
          {flow.num_packets > 0 ? `${flow.num_packets} pkt` : ""}
        </span>
        {flow.syn_meta && (
          <span className="row-syn" title={`SYN: ttl=${flow.syn_meta.ttl} win=${flow.syn_meta.win} mss=${flow.syn_meta.mss} ws=${flow.syn_meta.wscale} opts=${flow.syn_meta.opts}`}>
            t{flow.syn_meta.ttl}/{flow.syn_meta.opts}
          </span>
        )}
      </div>
    </div>
  );
}

export { FlowListEntry };
