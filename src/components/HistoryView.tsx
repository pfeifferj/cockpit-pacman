import React, { useState, useEffect, useLayoutEffect, useCallback, useRef } from "react";
import { usePackageDetails } from "../hooks/usePackageDetails";
import { usePagination } from "../hooks/usePagination";
import {
  Accordion,
  AccordionContent,
  Alert,
  AlertActionCloseButton,
  AlertActionLink,
  AccordionItem,
  AccordionToggle,
  Card,
  CardBody,
  Button,
  DatePicker,
  DescriptionList,
  DescriptionListDescription,
  DescriptionListGroup,
  DescriptionListTerm,
  EmptyState,
  EmptyStateBody,
  EmptyStateActions,
  EmptyStateFooter,
  Spinner,
  Flex,
  FlexItem,
  Label,
  MenuToggle,
  Pagination,
  Popover,
  SearchInput,
  Select,
  SelectOption,
  ToggleGroup,
  ToggleGroupItem,
  Toolbar,
  ToolbarContent,
  ToolbarItem,
  ToolbarToggleGroup,
  ToolbarFilter,
} from "@patternfly/react-core";
import { CompactPagination } from "./CompactPagination";
import { PackageDetailsDrawer, DETAILS_TRIGGER_ATTR, detailsRowProps } from "./PackageDetailsDrawer";
import { returnFocusToRow } from "../rowFocus";
import { PackageRowActions, PackageRowActionsProvider, fromRowActions } from "./PackageRowActions";
import { StatBox } from "./StatBox";
import { HistoryIcon, ArrowUpIcon, ArrowDownIcon, PlusIcon, MinusIcon, FilterIcon } from "@patternfly/react-icons";
import { Table, Thead, Tr, Th, Tbody, Td } from "@patternfly/react-table";
import {
  LogEntry,
  LogGroup,
  LogResponse,
  GroupedLogResponse,
  HistoryFilterType,
  HistoryParams,
  ScheduledRunEntry,
  TransactionOrigin,
  getGroupedHistory,
  getHistory,
  getScheduledRuns,
} from "../api";
import { TimeAgo } from "./TimeAgo";
import { describeRun, formatRunTime } from "./TransactionBanner";
import { ScheduleModal, RunDetails, RunStatus, formatDuration, runPackages } from "./ScheduleModal";
import { parseTimestamp } from "../timeFormat";
import { plural, sanitizeSearchInput } from "../utils";
import { LoadErrorState, RefreshFailedAlert, toLoadFailure, type LoadFailure } from "./LoadErrorState";
import { SEARCH_DEBOUNCE_MS } from "../constants";
import { useRefreshOnActivate, useTabActive } from "../hooks/useRefreshOnActivate";
import { useRouteOptionsSync, type RouteOptions } from "../hooks/useRoute";
import { useAnnounce, useResultAnnouncement } from "../contexts/AnnouncerContext";

type ViewState = "loading" | "ready" | "error";
type ViewMode = "grouped" | "flat";

const ACTION_COLORS: Record<string, "blue" | "green" | "red" | "orange" | "grey"> = {
  upgraded: "blue",
  downgraded: "orange",
  installed: "green",
  removed: "red",
  reinstalled: "grey",
};

const ACTION_ICONS: Record<string, React.ReactNode> = {
  upgraded: <ArrowUpIcon />,
  downgraded: <ArrowDownIcon />,
  installed: <PlusIcon />,
  removed: <MinusIcon />,
  reinstalled: <HistoryIcon />,
};

const FILTER_LABELS: Record<HistoryFilterType, string> = {
  all: "All actions",
  upgraded: "Upgraded",
  installed: "Installed",
  removed: "Removed",
  downgraded: "Downgraded",
  reinstalled: "Reinstalled",
};

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const ACTION_CATEGORY = "Action";
const UNTIL_CATEGORY = "Up to";

// Transaction ids shift when newer entries arrive.
const groupKey = (group: LogGroup): string => `${group.start_time}\u0000${group.command ?? ""}\u0000${group.part ?? 1}`;

// PF DatePicker reports partial input such as "2026-01-3" as a valid Date, so
// only a complete date that survives a round trip counts.
const isCompleteDate = (value: string, date?: Date): boolean =>
  !!date &&
  DATE_RE.test(value) &&
  `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}` === value;

// Window assumed around a scheduled run that recorded no duration. Such a record
// is stamped at the run's start, or at its end when systemd killed the run.
const UNKNOWN_RUN_WINDOW_MS = 10 * 60 * 1000;
const REFRESH_SPINNER_DELAY_MS = 1000;
const NO_KEYS: ReadonlySet<string> = new Set();

interface ScheduledMatch {
  kind: "scheduled" | "probable";
  run: ScheduledRunEntry;
}

function scheduledMatch(timestamp: string, runs: ScheduledRunEntry[]): ScheduledMatch | null {
  const started = parseTimestamp(timestamp)?.getTime();
  if (started === undefined) return null;
  let probable: ScheduledRunEntry | null = null;
  let probableGap = Infinity;
  for (const run of runs) {
    if (run.mode === "check" || run.status === "skipped") continue;
    const stamp = parseTimestamp(run.timestamp)?.getTime();
    if (stamp === undefined) continue;
    if (run.duration_secs !== null) {
      if (started >= stamp && started <= stamp + run.duration_secs * 1000) return { kind: "scheduled", run };
    } else {
      const gap = Math.abs(started - stamp);
      if (gap <= UNKNOWN_RUN_WINDOW_MS && gap < probableGap) {
        probable = run;
        probableGap = gap;
      }
    }
  }
  return probable ? { kind: "probable", run: probable } : null;
}

// Portalled popover content still bubbles React clicks to the row or toggle it came from.
const stopPropagation = (event: React.MouseEvent) => event.stopPropagation();

const ScheduledRunLabel: React.FC<{ match: ScheduledMatch; onShowInHistory: (run: ScheduledRunEntry) => void }> = ({
  match,
  onShowInHistory,
}) => {
  const { kind, run } = match;
  return (
    <Popover
      headerContent={kind === "scheduled" ? "Scheduled upgrade" : "Probably a scheduled upgrade"}
      bodyContent={
        <div onClick={stopPropagation}>
          <DescriptionList isCompact isHorizontal>
            <DescriptionListGroup>
              <DescriptionListTerm>Started</DescriptionListTerm>
              <DescriptionListDescription><TimeAgo timestamp={run.timestamp} /></DescriptionListDescription>
            </DescriptionListGroup>
            <DescriptionListGroup>
              <DescriptionListTerm>Status</DescriptionListTerm>
              <DescriptionListDescription><RunStatus run={run} /></DescriptionListDescription>
            </DescriptionListGroup>
            <DescriptionListGroup>
              <DescriptionListTerm>Packages</DescriptionListTerm>
              <DescriptionListDescription>{runPackages(run)}</DescriptionListDescription>
            </DescriptionListGroup>
            <DescriptionListGroup>
              <DescriptionListTerm>Duration</DescriptionListTerm>
              <DescriptionListDescription>{formatDuration(run.duration_secs)}</DescriptionListDescription>
            </DescriptionListGroup>
          </DescriptionList>
          <RunDetails run={run} />
          {kind === "probable" && (
            <p className="pf-v6-u-mt-sm">
              This run recorded no duration, so it is matched by start time only.
            </p>
          )}
        </div>
      }
      footerContent={(hide) => (
        <Button
          variant="link"
          isInline
          onClick={(event) => {
            event.stopPropagation();
            hide();
            onShowInHistory(run);
          }}
        >
          Show in run history
        </Button>
      )}
    >
      <Label color="teal" isCompact onClick={stopPropagation}>
        {kind === "scheduled" ? "Scheduled upgrade" : "Probably scheduled"}
      </Label>
    </Popover>
  );
};

const PER_PAGE_OPTIONS = [
  { title: "10", value: 10 },
  { title: "20", value: 20 },
  { title: "50", value: 50 },
];

// `at` names the start time of a transaction group to bring into view; it is dropped once shown.
function parseRoute(options: RouteOptions): RouteOptions {
  const filter = options.filter && Object.keys(FILTER_LABELS).includes(options.filter) ? options.filter : "all";
  return {
    q: sanitizeSearchInput(options.q ?? ""),
    filter: filter === "all" ? "" : filter,
    pkg: options.pkg ?? "",
    repo: options.pkg ? options.repo ?? "" : "",
    at: options.at ?? "",
  };
}

const entryKey = (entry: LogEntry) => `${entry.timestamp}|${entry.package}|${entry.action}`;

interface DetailsTarget {
  name: string;
  repo?: string;
}

interface HistoryViewProps {
  routeOptions?: RouteOptions;
  onRouteChange?: (options: RouteOptions) => void;
}

export const HistoryView: React.FC<HistoryViewProps> = ({ routeOptions, onRouteChange }) => {
  const [initialRoute] = useState(() => parseRoute(routeOptions ?? {}));
  const [state, setState] = useState<ViewState>("loading");
  const [viewMode, setViewMode] = useState<ViewMode>("grouped");
  const [groupedData, setGroupedData] = useState<GroupedLogResponse | null>(null);
  const [flatData, setFlatData] = useState<LogResponse | null>(null);
  const [error, setError] = useState<LoadFailure | null>(null);
  const [refreshError, setRefreshError] = useState<LoadFailure | null>(null);
  const { page, perPage, offset, setPage, onSetPage, onPerPageSelect } = usePagination({ defaultPerPage: 20 });
  const [filter, setFilter] = useState<HistoryFilterType>((initialRoute.filter || "all") as HistoryFilterType);
  const [filterOpen, setFilterOpen] = useState(false);
  const [searchInput, setSearchInput] = useState(initialRoute.q);
  const [searchQuery, setSearchQuery] = useState(initialRoute.q);
  const [until, setUntil] = useState("");
  const [target, setTarget] = useState(initialRoute.at);
  // Missing-target checks require a load started after the route changed.
  const [targetSeq, setTargetSeq] = useState(0);
  const [dataSeq, setDataSeq] = useState(0);
  const targetLoadRef = useRef<number | null>(null);
  const refreshHistoryRef = useRef<() => Promise<void>>(async () => {});
  const [focusRequest, setFocusRequest] = useState<{ id: string } | null>(null);
  const [dataOffset, setDataOffset] = useState(0);
  const [resultKey, setResultKey] = useState("grouped|all||");
  const searchInputRef = useRef<HTMLInputElement>(null);
  const filterToggleRef = useRef<ToolbarToggleGroup>(null);
  // PatternFly hardcodes the collapsed toggle's name as "Show Filters".
  useLayoutEffect(() => {
    filterToggleRef.current?.toggleRef.current?.setAttribute("aria-label", "Show filters");
  });
  const [expandedGroups, setExpandedGroups] = useState<Set<string>>(new Set());
  const expandAllRef = useRef(initialRoute.q !== "");
  const loadSeqRef = useRef(0);
  const loadAbortRef = useRef<AbortController | null>(null);
  const groupedDataRef = useRef(groupedData);
  const expandedGroupsRef = useRef(expandedGroups);
  const stateRef = useRef(state);
  useEffect(() => {
    groupedDataRef.current = groupedData;
    expandedGroupsRef.current = expandedGroups;
    stateRef.current = state;
  });
  const { selectedPackage, detailsLoading, detailsError, detailsErrorCode, detailsErrorContext, detailsRemoved, fetchDetails, refreshDetails, clearDetails } = usePackageDetails();
  const [detailsTarget, setDetailsTarget] = useState<DetailsTarget | null>(
    initialRoute.pkg ? { name: initialRoute.pkg, repo: initialRoute.repo || undefined } : null,
  );
  const [detailsRow, setDetailsRow] = useState<string | null>(null);
  const [scheduledRuns, setScheduledRuns] = useState<ScheduledRunEntry[]>([]);
  const [scheduleHistoryRun, setScheduleHistoryRun] = useState<string | null>(null);
  const [refreshing, setRefreshing] = useState(false);
  const [refreshSpinner, setRefreshSpinner] = useState(false);
  const spinnerTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const [newGroupKeys, setNewGroupKeys] = useState<ReadonlySet<string>>(NO_KEYS);
  const announce = useAnnounce();
  const tabActive = useTabActive();
  const [wasTabActive, setWasTabActive] = useState(tabActive);
  if (tabActive !== wasTabActive) {
    setWasTabActive(tabActive);
    if (!tabActive) setNewGroupKeys(NO_KEYS);
  }

  const stopRefreshing = useCallback(() => {
    if (spinnerTimerRef.current) clearTimeout(spinnerTimerRef.current);
    spinnerTimerRef.current = null;
    setRefreshing(false);
    setRefreshSpinner(false);
  }, []);
  useEffect(() => () => {
    if (spinnerTimerRef.current) clearTimeout(spinnerTimerRef.current);
  }, []);

  const loadScheduledRuns = useCallback(() => {
    getScheduledRuns().then((response) => setScheduledRuns(response.runs), () => {});
  }, []);

  const activeDetailsRow = !detailsTarget ? null : detailsRow ?? (() => {
    const entries = viewMode === "grouped" ? (groupedData?.groups ?? []).flatMap((g) => g.entries) : flatData?.entries ?? [];
    const entry = entries.find((e) => e.package === detailsTarget.name);
    return entry ? entryKey(entry) : null;
  })();

  useRouteOptionsSync(
    routeOptions,
    onRouteChange,
    { q: searchQuery, filter: filter === "all" ? "" : filter, pkg: detailsTarget?.name, repo: detailsTarget?.repo, at: target },
    parseRoute,
    (options) => {
      const nextFilter = (options.filter || "all") as HistoryFilterType;
      if (options.at !== target) {
        setTarget(options.at);
        if (options.at) {
          setTargetSeq(loadSeqRef.current);
          void refreshHistoryRef.current();
          targetLoadRef.current = loadSeqRef.current;
        }
      }
      if (options.q !== searchQuery) {
        setSearchInput(options.q);
        setSearchQuery(options.q);
        expandAllRef.current = options.q !== "";
      }
      if (nextFilter !== filter) setFilter(nextFilter);
      setPage(1);
      if (`${options.pkg}|${options.repo}` !== `${detailsTarget?.name ?? ""}|${detailsTarget?.repo ?? ""}`) {
        if (!options.pkg) returnFocusToRow(activeDetailsRow, DETAILS_TRIGGER_ATTR);
        setDetailsRow(null);
        setDetailsTarget(options.pkg ? { name: options.pkg, repo: options.repo || undefined } : null);
      }
    },
  );

  const fetchHistory = useCallback(
    (params: HistoryParams) => {
      loadAbortRef.current?.abort();
      const controller = new AbortController();
      loadAbortRef.current = controller;
      const request = { ...params, signal: controller.signal };
      return viewMode === "grouped" ? getGroupedHistory(request) : getHistory(request);
    },
    [viewMode]
  );

  const applyResponse = useCallback(
    (response: GroupedLogResponse | LogResponse) => {
      if (viewMode === "grouped") {
        const g = response as GroupedLogResponse;
        setGroupedData(g);
        const shouldExpandAll = expandAllRef.current;
        expandAllRef.current = false;
        setExpandedGroups(shouldExpandAll ? new Set(g.groups.map((x) => x.id)) : new Set());
      } else {
        setFlatData(response as LogResponse);
      }
    },
    [viewMode]
  );

  const loadHistory = useCallback(async () => {
    const seq = ++loadSeqRef.current;
    setState("loading");
    setError(null);
    setRefreshError(null);
    stopRefreshing();
    setNewGroupKeys(NO_KEYS);
    loadScheduledRuns();
    try {
      const response = await fetchHistory({ offset, limit: perPage, filter, search: searchQuery, until: until || undefined });
      if (seq !== loadSeqRef.current) return;
      applyResponse(response);
      setResultKey(`${viewMode}|${filter}|${searchQuery}|${until}`);
      setDataOffset(offset);
      setDataSeq(seq);
      setState("ready");
    } catch (ex) {
      if (seq !== loadSeqRef.current) return;
      setState("error");
      setError(toLoadFailure(ex));
    }
  }, [offset, perPage, filter, searchQuery, until, viewMode, fetchHistory, applyResponse, stopRefreshing, loadScheduledRuns]);

  // Auto-load on input/mode change. setState stays inside .then/.catch (the
  // set-state-in-effect lint rejects it factored through a helper).
  useEffect(() => {
    let cancelled = false;
    const seq = ++loadSeqRef.current;
    loadScheduledRuns();
    fetchHistory({ offset, limit: perPage, filter, search: searchQuery, until: until || undefined })
      .then((response) => {
        if (cancelled || seq !== loadSeqRef.current) return;
        stopRefreshing();
        setRefreshError(null);
        setNewGroupKeys(NO_KEYS);
        applyResponse(response);
        setResultKey(`${viewMode}|${filter}|${searchQuery}|${until}`);
        setDataOffset(offset);
        setDataSeq(seq);
        setState("ready");
      })
      .catch((ex) => {
        if (cancelled || seq !== loadSeqRef.current) return;
        stopRefreshing();
        setRefreshError(null);
        setState("error");
        setError(toLoadFailure(ex));
      });
    return () => { cancelled = true; loadAbortRef.current?.abort(); };
  }, [offset, perPage, filter, searchQuery, until, viewMode, fetchHistory, applyResponse, stopRefreshing, loadScheduledRuns]);

  const refreshHistory = useCallback(async () => {
    const seq = ++loadSeqRef.current;
    setRefreshing(true);
    if (!spinnerTimerRef.current) {
      spinnerTimerRef.current = setTimeout(() => setRefreshSpinner(true), REFRESH_SPINNER_DELAY_MS);
    }
    loadScheduledRuns();
    try {
      const response = await fetchHistory({ offset, limit: perPage, filter, search: searchQuery, until: until || undefined });
      if (seq === targetLoadRef.current) targetLoadRef.current = null;
      if (seq !== loadSeqRef.current) return;
      stopRefreshing();
      setRefreshError(null);
      const rows = viewMode === "grouped"
        ? (response as GroupedLogResponse).groups.length
        : (response as LogResponse).entries.length;
      const count = viewMode === "grouped"
        ? (response as GroupedLogResponse).total_groups
        : (response as LogResponse).total;
      if (rows === 0 && offset > 0 && count > 0) {
        setPage(Math.ceil(count / perPage));
        return;
      }
      if (viewMode === "grouped") {
        const g = response as GroupedLogResponse;
        const previous = groupedDataRef.current?.groups ?? [];
        const expandedKeys = new Set(
          previous.filter((x) => expandedGroupsRef.current.has(x.id)).map(groupKey),
        );
        setGroupedData(g);
        setExpandedGroups(new Set(g.groups.filter((x) => expandedKeys.has(groupKey(x))).map((x) => x.id)));
        // Only the first page grows at the top; elsewhere groups shift in from the next page.
        if (offset === 0 && previous.length > 0) {
          const previousKeys = new Set(previous.map(groupKey));
          const firstOld = g.groups.findIndex((x) => previousKeys.has(groupKey(x)));
          const added = (firstOld === -1 ? g.groups : g.groups.slice(0, firstOld)).map(groupKey);
          if (added.length > 0) {
            setNewGroupKeys((keys) => new Set([...keys, ...added]));
            announce(plural(added.length, "new transaction"));
          }
        }
      } else {
        setFlatData(response as LogResponse);
      }
      setDataSeq(seq);
      setState("ready");
    } catch (ex) {
      if (seq === targetLoadRef.current) targetLoadRef.current = null;
      if (seq !== loadSeqRef.current) return;
      stopRefreshing();
      if (stateRef.current === "ready") {
        setRefreshError(toLoadFailure(ex));
      } else {
        setState("error");
        setError(toLoadFailure(ex));
      }
    }
  }, [offset, perPage, filter, searchQuery, until, viewMode, fetchHistory, setPage, stopRefreshing, loadScheduledRuns, announce]);

  useEffect(() => {
    refreshHistoryRef.current = refreshHistory;
  });

  useRefreshOnActivate(() => {
    // A target routed together with the activation already started a fresh reload.
    if (targetLoadRef.current === null || targetLoadRef.current !== loadSeqRef.current) refreshHistory();
    void refreshDetails();
  });

  useEffect(() => {
    const sanitized = sanitizeSearchInput(searchInput);
    if (sanitized === searchQuery) return;
    const timer = setTimeout(() => {
      setSearchQuery(sanitized);
      setPage(1);
    }, SEARCH_DEBOUNCE_MS);
    return () => clearTimeout(timer);
  }, [searchInput, searchQuery, setPage]);

  useEffect(() => {
    if (detailsTarget) {
      fetchDetails(detailsTarget.name, detailsTarget.repo ? { strategy: "sync", repo: detailsTarget.repo } : { strategy: "local-then-sync" });
    } else {
      clearDetails();
    }
  }, [detailsTarget, fetchDetails, clearDetails]);

  const handleRowClick = (rowKey: string, pkgName: string) => {
    setDetailsRow(rowKey);
    setDetailsTarget((current) => (current?.name === pkgName && !current.repo ? current : { name: pkgName }));
  };

  const closeDetails = () => {
    setDetailsRow(null);
    setDetailsTarget(null);
  };

  const handleFilterChange = (value: HistoryFilterType) => {
    setFilter(value);
    setPage(1);
    setFilterOpen(false);
  };

  const handleUntilChange = (value: string, date?: Date) => {
    const next = value === "" ? "" : isCompleteDate(value, date) ? value : null;
    if (next === null || next === until) return;
    setUntil(next);
    setPage(1);
  };

  const clearFilters = () => {
    // Keep the toolbar mounted while the empty result is replaced.
    setState("loading");
    setFilter("all");
    setSearchInput("");
    setSearchQuery("");
    setUntil("");
    setPage(1);
    searchInputRef.current?.focus();
  };

  const showTarget = () => {
    setState("loading");
    setViewMode("grouped");
    setFilter("all");
    setSearchInput("");
    setSearchQuery("");
    setUntil("");
    setPage(1);
    searchInputRef.current?.focus();
  };

  const backToLatest = () => {
    // The link unmounts with `until`; keep focus in the toolbar instead of body.
    setState("loading");
    setUntil("");
    setPage(1);
    searchInputRef.current?.focus();
  };

  const clearActionFilter = () => {
    setState("loading");
    handleFilterChange("all");
    searchInputRef.current?.focus();
  };

  const actionChip = filter !== "all" ? [FILTER_LABELS[filter]] : [];
  const untilChip = until ? [until] : [];

  const handleViewModeChange = (mode: ViewMode) => {
    if (mode === viewMode) return;
    setState("loading");
    setViewMode(mode);
    setPage(1);
  };

  const allExpanded = groupedData?.groups.length
    ? groupedData.groups.every((g) => expandedGroups.has(g.id))
    : false;

  const toggleAllGroups = () => {
    if (allExpanded) {
      expandAllRef.current = false;
      setExpandedGroups(new Set());
    } else {
      expandAllRef.current = true;
      setExpandedGroups(new Set(groupedData?.groups.map((g) => g.id) || []));
    }
  };

  const toggleGroup = (groupId: string) => {
    expandAllRef.current = false;
    setExpandedGroups((prev) => {
      const next = new Set(prev);
      if (next.has(groupId)) {
        next.delete(groupId);
      } else {
        next.add(groupId);
      }
      return next;
    });
  };

  const formatVersion = (entry: LogEntry): string => {
    if (entry.old_version && entry.new_version) {
      return `${entry.old_version} -> ${entry.new_version}`;
    }
    return entry.old_version || entry.new_version || "";
  };

  const showRunInHistory = (run: ScheduledRunEntry) => setScheduleHistoryRun(run.timestamp);

  // The logged origin decides; the time-window match only guesses for records without one.
  const renderOriginLabel = (origin: TransactionOrigin | null, timestamp: string): React.ReactNode => {
    if (origin === "cockpit") return <Label color="grey" isCompact>From Cockpit</Label>;
    if (origin === "pacman") return null;
    const match = scheduledMatch(timestamp, scheduledRuns);
    if (origin === "scheduled") {
      return match
        ? <ScheduledRunLabel match={{ ...match, kind: "scheduled" }} onShowInHistory={showRunInHistory} />
        : <Label color="teal" isCompact>Scheduled upgrade</Label>;
    }
    return match ? <ScheduledRunLabel match={match} onShowInHistory={showRunInHistory} /> : null;
  };

  const renderEntryRow = (entry: LogEntry, index: number, flat = false): React.ReactNode => {
    const originLabel = flat ? renderOriginLabel(entry.origin, entry.timestamp) : null;
    const rowKey = entryKey(entry);
    return (
      <Tr
        key={`${entry.timestamp}-${entry.package}-${index}`}
        isClickable
        onRowClick={(event) => !fromRowActions(event) && handleRowClick(rowKey, entry.package)}
        {...detailsRowProps(activeDetailsRow === rowKey)}
      >
        <Td dataLabel="Package">
          <Button variant="link" isInline className="pf-v6-u-p-0" {...{ [DETAILS_TRIGGER_ATTR]: rowKey }}>
            {entry.package}
          </Button>
        </Td>
        <Td dataLabel="Version">
          <code>{formatVersion(entry)}</code>
        </Td>
        <Td dataLabel="Action">
          <Label color={ACTION_COLORS[entry.action] || "grey"} icon={ACTION_ICONS[entry.action]}>
            {entry.action}
          </Label>
        </Td>
        <Td dataLabel="Time">
          <TimeAgo timestamp={entry.timestamp} />
          {originLabel && <span className="pf-v6-u-ml-sm">{originLabel}</span>}
        </Td>
        <Td isActionCell>
          <PackageRowActions
            name={entry.package}
            downgradeTo={entry.action === "upgraded" ? entry.old_version : null}
            onViewDetails={() => handleRowClick(rowKey, entry.package)}
          />
        </Td>
      </Tr>
    );
  };

  const renderGroupSummary = (group: LogGroup): React.ReactNode => {
    const labels: React.ReactNode[] = [];
    if (group.upgraded_count > 0) {
      labels.push(
        <Label key="upgraded" color="blue" isCompact>
          {group.upgraded_count} upgraded
        </Label>
      );
    }
    if (group.installed_count > 0) {
      labels.push(
        <Label key="installed" color="green" isCompact>
          {group.installed_count} installed
        </Label>
      );
    }
    if (group.removed_count > 0) {
      labels.push(
        <Label key="removed" color="red" isCompact>
          {group.removed_count} removed
        </Label>
      );
    }
    if (group.downgraded_count > 0) {
      labels.push(
        <Label key="downgraded" color="orange" isCompact>
          {group.downgraded_count} downgraded
        </Label>
      );
    }
    if (group.reinstalled_count > 0) {
      labels.push(
        <Label key="reinstalled" color="grey" isCompact>
          {group.reinstalled_count} reinstalled
        </Label>
      );
    }
    return labels;
  };

  // Active dataset for the current view mode drives stats, empty-states, paging.
  const totals = viewMode === "grouped" ? groupedData : flatData;
  const hasData = !!totals;
  const itemCount = viewMode === "grouped" ? (groupedData?.total_groups || 0) : (flatData?.total || 0);
  const resultCount = viewMode === "grouped" ? (groupedData?.groups.length || 0) : (flatData?.entries.length || 0);
  const noun = viewMode === "grouped"
    ? (itemCount === 1 ? "transaction" : "transactions")
    : (itemCount === 1 ? "entry" : "entries");
  useResultAnnouncement(
    state !== "ready" ? null : itemCount === 0 ? "No history entries match" : `${itemCount.toLocaleString()} ${noun}`,
    resultKey,
  );

  const dataCurrent = state === "ready"
    && resultKey === `${viewMode}|${filter}|${searchQuery}|${until}`
    && dataOffset === offset;
  const targetGroup = target && viewMode === "grouped"
    ? groupedData?.groups.find((g) => g.start_time === target)
    : undefined;
  if (target && dataCurrent && targetGroup) {
    setTarget("");
    setExpandedGroups((prev) => new Set(prev).add(targetGroup.id));
    setFocusRequest({ id: targetGroup.id });
  }
  const targetHidden = filter !== "all" || searchQuery !== "" || until !== "" || viewMode === "flat" || offset > 0;
  const targetNotice = target && dataCurrent && dataSeq > targetSeq && !targetGroup
    ? targetHidden
      ? `The transaction from ${formatRunTime(target)} is hidden by the current view`
      : `The transaction from ${formatRunTime(target)} is not in the history`
    : null;

  useEffect(() => {
    if (targetNotice) announce(targetNotice);
  }, [targetNotice, announce]);

  useEffect(() => {
    if (!focusRequest) return;
    const toggle = document.getElementById(`${focusRequest.id}-toggle`);
    toggle?.scrollIntoView?.({ block: "center" });
    toggle?.focus({ preventScroll: true });
  }, [focusRequest]);

  if (state === "loading" && !hasData) {
    return (
      <Card>
        <CardBody>
          <EmptyState headingLevel="h2" icon={Spinner} titleText="Loading history">
            <EmptyStateBody>Reading pacman.log…</EmptyStateBody>
          </EmptyState>
        </CardBody>
      </Card>
    );
  }

  if (state === "error" && !hasData) {
    return (
      <Card>
        <CardBody>
          <LoadErrorState what="history" error={error?.message} code={error?.code} details={error?.details} onRetry={loadHistory} />
        </CardBody>
      </Card>
    );
  }

  if (!resultCount && filter === "all" && !searchQuery && !until && state !== "loading") {
    return (
      <Card>
        <CardBody>
          <EmptyState headingLevel="h2" icon={HistoryIcon} titleText="No history found">
            <EmptyStateBody>
              No package history was found in /var/log/pacman.log.
            </EmptyStateBody>
            <EmptyStateFooter>
              <EmptyStateActions>
                <Button variant="secondary" onClick={loadHistory}>
                  Refresh
                </Button>
              </EmptyStateActions>
            </EmptyStateFooter>
          </EmptyState>
        </CardBody>
      </Card>
    );
  }

  return (
    <Card>
      <CardBody>
        <Flex justifyContent={{ default: "justifyContentSpaceBetween" }} alignItems={{ default: "alignItemsFlexStart" }}>
          <FlexItem>
            <Flex spaceItems={{ default: "spaceItemsLg" }} className="pf-v6-u-mb-md">
              <FlexItem>
                <StatBox
                  label="Upgraded"
                  value={(totals?.total_upgraded || 0).toLocaleString()}
                  color="info"
                />
              </FlexItem>
              <FlexItem>
                <StatBox
                  label="Installed"
                  value={(totals?.total_installed || 0).toLocaleString()}
                  color="success"
                />
              </FlexItem>
              <FlexItem>
                <StatBox
                  label="Removed"
                  value={(totals?.total_removed || 0).toLocaleString()}
                  color="danger"
                />
              </FlexItem>
              {(totals?.total_other || 0) > 0 && (
                <FlexItem>
                  <StatBox
                    label="Other"
                    value={(totals?.total_other || 0).toLocaleString()}
                    color="warning"
                  />
                </FlexItem>
              )}
            </Flex>
          </FlexItem>
        </Flex>

        <Toolbar
          clearAllFilters={clearFilters}
          clearFiltersButtonText="Clear filters"
          numberOfFiltersText={() => `Showing ${[...actionChip, ...untilChip.map((d) => `up to ${d}`)].join(", ")}`}
        >
          <ToolbarContent>
            <ToolbarItem>
              <SearchInput
                ref={searchInputRef}
                placeholder="Filter by package name…"
                value={searchInput}
                onChange={(_event, value) => setSearchInput(value)}
                onClear={() => setSearchInput("")}
                aria-label="Filter history by package name"
              />
            </ToolbarItem>
            <ToolbarToggleGroup ref={filterToggleRef} toggleIcon={<FilterIcon />} breakpoint="lg">
              <ToolbarItem>
                <ToggleGroup aria-label="History view mode">
                  <ToggleGroupItem
                    text="Grouped"
                    isSelected={viewMode === "grouped"}
                    onChange={() => handleViewModeChange("grouped")}
                  />
                  <ToggleGroupItem
                    text="Flat"
                    isSelected={viewMode === "flat"}
                    onChange={() => handleViewModeChange("flat")}
                  />
                </ToggleGroup>
              </ToolbarItem>
              <ToolbarFilter
                labels={actionChip}
                deleteLabel={clearActionFilter}
                categoryName={ACTION_CATEGORY}
              >
                <Select
                  toggle={(toggleRef) => (
                    <MenuToggle
                      ref={toggleRef}
                      onClick={() => setFilterOpen(!filterOpen)}
                      isExpanded={filterOpen}
                    >
                      {FILTER_LABELS[filter]}
                    </MenuToggle>
                  )}
                  onSelect={(_event, value) => handleFilterChange(value as HistoryFilterType)}
                  selected={filter}
                  isOpen={filterOpen}
                  onOpenChange={(isOpen) => setFilterOpen(isOpen)}
                >
                  {(Object.keys(FILTER_LABELS) as HistoryFilterType[]).map((value) => (
                    <SelectOption key={value} value={value}>{FILTER_LABELS[value]}</SelectOption>
                  ))}
                </Select>
              </ToolbarFilter>
              <ToolbarFilter
                labels={untilChip}
                deleteLabel={backToLatest}
                categoryName={UNTIL_CATEGORY}
              >
                <DatePicker
                  value={until}
                  onChange={(_event, value, date) => handleUntilChange(value, date)}
                  aria-label="Show history up to date"
                  buttonAriaLabel="Choose a date to show history up to"
                />
              </ToolbarFilter>
            </ToolbarToggleGroup>
            {viewMode === "grouped" && (
              <ToolbarItem>
                <Button
                  variant="secondary"
                  onClick={toggleAllGroups}
                  isDisabled={!groupedData?.groups.length}
                >
                  {allExpanded ? "Collapse all" : "Expand all"}
                </Button>
              </ToolbarItem>
            )}
            {refreshSpinner && (
              <ToolbarItem alignSelf="center">
                <Spinner size="md" aria-label="Refreshing history" />
              </ToolbarItem>
            )}
            <ToolbarItem variant="pagination" align={{ default: "alignEnd" }}>
              <CompactPagination
                itemCount={itemCount}
                perPage={perPage}
                page={page}
                onSetPage={onSetPage}
                onPerPageSelect={onPerPageSelect}
                perPageOptions={PER_PAGE_OPTIONS}
              />
            </ToolbarItem>
          </ToolbarContent>
        </Toolbar>

        {refreshError && state === "ready" && (
          <RefreshFailedAlert
            what="history"
            error={refreshError.message}
            details={refreshError.details}
            onRetry={() => { void refreshHistory(); }}
            onClose={() => setRefreshError(null)}
          />
        )}

        {targetNotice && (
          <Alert
            variant={targetHidden ? "info" : "warning"}
            isInline
            isPlain
            title={targetNotice}
            className="pf-v6-u-mb-sm"
            actionClose={<AlertActionCloseButton onClose={() => setTarget("")} />}
            actionLinks={targetHidden && <AlertActionLink onClick={showTarget}>Show it</AlertActionLink>}
          />
        )}

        {until && (
          <Flex spaceItems={{ default: "spaceItemsSm" }} alignItems={{ default: "alignItemsCenter" }} className="pf-v6-u-mb-sm">
            <FlexItem>Showing entries up to {until}</FlexItem>
            <FlexItem>
              <Button variant="link" isInline onClick={backToLatest}>
                Back to latest
              </Button>
            </FlexItem>
          </Flex>
        )}

        <PackageRowActionsProvider>
        <PackageDetailsDrawer
          activeKey={activeDetailsRow}
          packageDetails={selectedPackage}
          isLoading={detailsLoading}
          onClose={closeDetails}
          error={detailsError}
          errorCode={detailsErrorCode}
          errorDetails={detailsErrorContext}
          isRemoved={detailsRemoved}
        >
        {state === "loading" ? (
          <EmptyState headingLevel="h3" icon={Spinner} titleText="Loading history" />
        ) : state === "error" ? (
          <LoadErrorState what="history" error={error?.message} code={error?.code} details={error?.details} onRetry={loadHistory} headingLevel="h3" />
        ) : !resultCount ? (
          <EmptyState headingLevel="h3" titleText="No matching entries">
            <EmptyStateBody>
              {searchQuery ? `No history found for "${searchQuery}"` : "No history found"}
              {filter !== "all" && ` with action "${FILTER_LABELS[filter]}"`}
              {until && ` up to ${until}`}.
            </EmptyStateBody>
            <EmptyStateFooter>
              <EmptyStateActions>
                <Button variant="link" onClick={clearFilters}>Clear filters</Button>
              </EmptyStateActions>
            </EmptyStateFooter>
          </EmptyState>
        ) : viewMode === "flat" ? (
          <>
            <Table aria-label="Package history (flat)" variant="compact" aria-busy={refreshing}>
              <Thead>
                <Tr>
                  <Th>Package</Th>
                  <Th>Version</Th>
                  <Th>Action</Th>
                  <Th>Time</Th>
                  <Th screenReaderText="Actions" />
                </Tr>
              </Thead>
              <Tbody>
                {flatData?.entries.map((entry: LogEntry, index: number) => renderEntryRow(entry, index, true))}
              </Tbody>
            </Table>

            <Pagination
              itemCount={itemCount}
              perPage={perPage}
              page={page}
              onSetPage={onSetPage}
              onPerPageSelect={onPerPageSelect}
              perPageOptions={PER_PAGE_OPTIONS}
              variant="bottom"
            />
          </>
        ) : (
          <>
            <Accordion asDefinitionList={false} aria-busy={refreshing}>
              {groupedData?.groups.map((group: LogGroup) => {
                const originLabel = renderOriginLabel(group.origin, group.start_time);
                return (
                <AccordionItem key={group.id} isExpanded={expandedGroups.has(group.id)}>
                  <Flex flexWrap={{ default: "nowrap" }} alignItems={{ default: "alignItemsCenter" }} spaceItems={{ default: "spaceItemsNone" }}>
                    <FlexItem grow={{ default: "grow" }} style={{ minWidth: 0 }}>
                      <AccordionToggle
                        onClick={() => toggleGroup(group.id)}
                        id={`${group.id}-toggle`}
                      >
                        <Flex
                          justifyContent={{ default: "justifyContentSpaceBetween" }}
                          alignItems={{ default: "alignItemsCenter" }}
                          style={{ width: "100%" }}
                        >
                          <FlexItem>
                            <span style={{ fontWeight: 500 }}><TimeAgo timestamp={group.start_time} /></span>
                            {group.entries.length > 1 && (
                              <span style={{ color: "var(--pf-t--global--text--color--subtle)", marginLeft: "0.5rem" }}>
                                ({plural(group.entries.length, "package")})
                              </span>
                            )}
                            {group.part && group.parts && (
                              <Label isCompact className="pf-v6-u-ml-sm">Part {group.part} of {group.parts}</Label>
                            )}
                            {group.command && (group.origin === "cockpit" || group.origin === "scheduled" ? (
                              <div style={{ color: "var(--pf-t--global--text--color--subtle)" }}>{describeRun(group.command)}</div>
                            ) : (
                              <div>
                                <code style={{ color: "var(--pf-t--global--text--color--subtle)" }}>{group.command}</code>
                              </div>
                            ))}
                          </FlexItem>
                          <FlexItem>
                            <Flex spaceItems={{ default: "spaceItemsSm" }}>
                              {newGroupKeys.has(groupKey(group)) && (
                                <Label color="purple" isCompact>New</Label>
                              )}
                              {renderGroupSummary(group)}
                            </Flex>
                          </FlexItem>
                        </Flex>
                      </AccordionToggle>
                    </FlexItem>
                    {originLabel && <FlexItem className="pf-v6-u-px-md">{originLabel}</FlexItem>}
                  </Flex>
                  <AccordionContent id={`${group.id}-content`} hidden={!expandedGroups.has(group.id)}>
                    {expandedGroups.has(group.id) && (
                      <Table aria-label={`Package history for ${group.id}`} variant="compact">
                        <Thead>
                          <Tr>
                            <Th>Package</Th>
                            <Th>Version</Th>
                            <Th>Action</Th>
                            <Th>Time</Th>
                            <Th screenReaderText="Actions" />
                          </Tr>
                        </Thead>
                        <Tbody>
                          {group.entries.map((entry: LogEntry, index: number) => renderEntryRow(entry, index))}
                        </Tbody>
                      </Table>
                    )}
                  </AccordionContent>
                </AccordionItem>
                );
              })}
            </Accordion>

            <Pagination
              itemCount={itemCount}
              perPage={perPage}
              page={page}
              onSetPage={onSetPage}
              onPerPageSelect={onPerPageSelect}
              perPageOptions={PER_PAGE_OPTIONS}
              variant="bottom"
            />
          </>
        )}
        </PackageDetailsDrawer>
        </PackageRowActionsProvider>

        <ScheduleModal
          isOpen={scheduleHistoryRun !== null}
          onClose={() => setScheduleHistoryRun(null)}
          focusRun={scheduleHistoryRun ?? undefined}
        />
      </CardBody>
    </Card>
  );
};
