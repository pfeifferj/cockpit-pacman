import React, { useState, useEffect, useCallback, useRef, useId } from "react";
import { useBackdropClose } from "../hooks/useBackdropClose";
import { usePackageDetails } from "../hooks/usePackageDetails";
import { usePagination } from "../hooks/usePagination";
import { useSortableTable } from "../hooks/useSortableTable";
import { useAdminPermission } from "../hooks/useAdminPermission";
import { useMutationGate } from "../hooks/useMutationGate";
import { GatedButton } from "./GatedButton";
import { useRefreshOnActivate } from "../hooks/useRefreshOnActivate";
import { useDebouncedValue } from "../hooks/useDebounce";
import { useAnnounce, useResultAnnouncement } from "../contexts/AnnouncerContext";
import { useNavigation } from "../contexts/NavigationContext";
import { SEARCH_DEBOUNCE_MS } from "../constants";
import {
  Card,
  CardBody,
  CardTitle,
  Button,
  Checkbox,
  EmptyState,
  EmptyStateBody,
  EmptyStateActions,
  EmptyStateFooter,
  Spinner,
  Flex,
  FlexItem,
  Content,
  ContentVariants,
  Slider,
  SearchInput,
  Toolbar,
  ToolbarContent,
  ToolbarItem,
  Label,
  Alert,
  AlertActionCloseButton,
  AlertActionLink,
  Progress,
  ProgressMeasureLocation,
} from "@patternfly/react-core";
import { ExpandableLogViewer, LogViewer } from "./LogViewer";
import { CompactPagination } from "./CompactPagination";
import { TrashIcon, CheckCircleIcon, FolderIcon, ExclamationCircleIcon, SearchIcon, InfoCircleIcon } from "@patternfly/react-icons";
import { PackageDetailsDrawer, DETAILS_TRIGGER_ATTR, detailsRowProps } from "./PackageDetailsDrawer";
import { returnFocusToRow } from "../rowFocus";
import { PackageRowActions, PackageRowActionsProvider } from "./PackageRowActions";
import { ConfirmModal } from "./ConfirmModal";
import { CacheFilesModal } from "./CacheFilesModal";
import { ErrorDetails } from "./ErrorDetails";
import { ErrorAlert } from "./ErrorAlert";
import { useStreamingLog } from "../hooks/useStreamingLog";
import { StatBox } from "./StatBox";
import { HelpPopover } from "./HelpPopover";
import { Table, Thead, Tr, Th, Tbody, Td } from "@patternfly/react-table";
import {
  CacheInfo,
  CacheSelection,
  type ErrorCode,
  previewCacheCleanup,
  getCacheInfo,
  cleanCache,
  formatSize,
} from "../api";
import { plural, sanitizeErrorMessage } from "../utils";
import { useRouteOptionsSync, type RouteOptions } from "../hooks/useRoute";
import { LoadErrorState, toLoadFailure, type LoadFailure } from "./LoadErrorState";
import { DEFAULT_KEEP_VERSIONS, keepFreeing, type CleanupProjection } from "../cacheProjection";
import { formatAtLeast } from "./TransactionRisks";
import { RowSelectCell } from "./RowSelectCell";

function cacheSelection(all: boolean, names: ReadonlySet<string>): CacheSelection {
  if (all && names.size === 0) return { mode: "all" };
  return { mode: all ? "except" : "only", names: [...names].sort() };
}

type ViewState = "loading" | "ready" | "cleaning" | "success" | "stopped" | "error" | "cleanError";

interface SpaceCheck {
  need: UpgradeSpaceNeed;
  /** Free bytes when the need arrived; undefined until read, null when unmeasurable. */
  baseline: number | null | undefined;
  /** Latest free bytes; undefined until read, null when unmeasurable. */
  free: number | null | undefined;
  deleted: number;
  measuring: boolean;
  cleaned: boolean;
}

const newSpaceCheck = (need: UpgradeSpaceNeed): SpaceCheck =>
  ({ need, baseline: undefined, free: undefined, deleted: 0, measuring: false, cleaned: false });

function freeOn(info: CacheInfo, need: UpgradeSpaceNeed): number | null {
  return info.free_space && info.free_space.mount === need.mount ? info.free_space.free_bytes : null;
}

type SpaceVerdict =
  | { kind: "enough" | "short"; free: number; required: number }
  | { kind: "unmeasured" };

function spaceVerdict(check: SpaceCheck): SpaceVerdict {
  if (check.baseline == null || check.free == null) return { kind: "unmeasured" };
  const required = check.baseline + check.need.deficit;
  return { kind: check.free >= required ? "enough" : "short", free: check.free, required };
}

const filesLabel = (n: number) => plural(n, "file");

export interface UpgradeSpaceNeed {
  deficit: number;
  mount: string;
  holds_cache?: boolean;
}

function parseRoute(options: RouteOptions): RouteOptions {
  return { pkg: options.pkg ?? "", repo: options.pkg ? options.repo ?? "" : "" };
}

interface DetailsTarget {
  name: string;
  repo?: string;
}

interface CacheViewProps {
  routeOptions?: RouteOptions;
  onRouteChange?: (options: RouteOptions) => void;
  upgradeNeed?: UpgradeSpaceNeed | null;
  /** Returns to the blocked upgrade, which checks the space again. */
  onBackToUpgrade?: () => void;
  onDismissUpgradeNeed?: () => void;
}

export const CacheView: React.FC<CacheViewProps> = ({
  routeOptions, onRouteChange, upgradeNeed = null, onBackToUpgrade, onDismissUpgradeNeed,
}) => {
  const [initialRoute] = useState(() => parseRoute(routeOptions ?? {}));
  const [state, setState] = useState<ViewState>("loading");
  const [cacheData, setCacheData] = useState<CacheInfo | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [errorDetails, setErrorDetails] = useState<string | undefined>(undefined);
  const { log, appendLog, flushLog, resetLog } = useStreamingLog();
  const [errorCode, setErrorCode] = useState<ErrorCode>();
  const [resultMessage, setResultMessage] = useState<string | null>(null);
  const [isDetailsExpanded, setIsDetailsExpanded] = useState(false);
  const [confirmModalOpen, setConfirmModalOpen] = useState(false);
  const [previewEpoch, setPreviewEpoch] = useState(0);
  useBackdropClose(confirmModalOpen, () => setConfirmModalOpen(false));
  const [keepVersions, setKeepVersions] = useState(DEFAULT_KEEP_VERSIONS);
  const [searchFilter, setSearchFilter] = useState("");
  const [selected, setSelected] = useState<CacheSelection>({ mode: "all" });
  const selection = { all: selected.mode !== "only", names: new Set(selected.mode === "all" ? [] : selected.names) };
  const [filesPackage, setFilesPackage] = useState<string | null>(null);
  const [refresh, setRefresh] = useState(0);
  const [loading, setLoading] = useState(true);
  const [loadedFilter, setLoadedFilter] = useState<string | null>(null);
  const announceProjectionRef = useRef(false);
  const debouncedFilter = useDebouncedValue(searchFilter, SEARCH_DEBOUNCE_MS);
  const isMountedRef = useRef(true);
  const { selectedPackage, detailsLoading, detailsError, detailsErrorCode, detailsErrorContext, detailsRemoved, fetchDetails, refreshDetails, clearDetails } = usePackageDetails();
  const [detailsTarget, setDetailsTarget] = useState<DetailsTarget | null>(
    initialRoute.pkg ? { name: initialRoute.pkg, repo: initialRoute.repo || undefined } : null,
  );
  const detailsName = detailsTarget?.name ?? null;
  const { page, perPage, setPage, onSetPage, onPerPageSelect, resetPage } = usePagination();
  const cancelRef = useRef<(() => void) | null>(null);
  const cleanRunRef = useRef(0);
  const [stopAsked, setStopAsked] = useState(false);
  const [stopping, setStopping] = useState(false);
  const stoppingRef = useRef(false);
  const [finishedAfterStop, setFinishedAfterStop] = useState(false);
  const [cleanProgress, setCleanProgress] = useState<{ current: number; total: number } | null>(null);
  const stopQuestionId = useId();
  const stopButtonRef = useRef<React.ComponentRef<"button">>(null);
  const keepRunningRef = useRef<React.ComponentRef<"button">>(null);
  const stopFocusRef = useRef<"stop" | "keep" | null>(null);
  const stateRef = useRef(state);
  const canAdminister = useAdminPermission();
  const { onViewOrphans } = useNavigation();
  const announce = useAnnounce();
  const cleanGate = useMutationGate("clean the package cache", { permission: canAdminister });

  const { activeSortKey, activeSortDirection, getSortParams } = useSortableTable({
    columns: { name: 0, version: 1, size: 2 },
    defaultDirection: "asc",
    onSort: resetPage,
  });

  const failLoad = useCallback((ex: unknown) => {
    const failure = toLoadFailure(ex);
    setState("error");
    setError(failure.message);
    setErrorDetails(failure.details);
    setErrorCode(failure.code);
  }, []);

  const loadCacheInfo = () => {
    setState("ready");
    setPage(1);
    setRefresh(value => value + 1);
  };

  // A smaller cache does not imply freed blocks on snapshotting filesystems.
  const [spaceCheck, setSpaceCheck] = useState<SpaceCheck | null>(null);
  const spaceCheckRef = useRef(spaceCheck);
  const upgradeNeedRef = useRef(upgradeNeed);
  useEffect(() => {
    upgradeNeedRef.current = upgradeNeed;
  }, [upgradeNeed]);
  const updateSpaceCheck = (update: (check: SpaceCheck) => SpaceCheck): SpaceCheck | null => {
    const need = upgradeNeedRef.current;
    if (!need) return null;
    const prev = spaceCheckRef.current?.need === need ? spaceCheckRef.current : newSpaceCheck(need);
    const next = update(prev);
    spaceCheckRef.current = next;
    setSpaceCheck(next);
    return next;
  };

  useEffect(() => {
    if (!upgradeNeed) return;
    const controller = new AbortController();
    getCacheInfo({ limit: 1, signal: controller.signal })
      .then((info) => {
        if (controller.signal.aborted) return;
        const free = freeOn(info, upgradeNeed);
        updateSpaceCheck((c) => ({ ...c, baseline: free, free: c.free === undefined ? free : c.free }));
      })
      .catch(() => {
        if (!controller.signal.aborted) updateSpaceCheck((c) => ({ ...c, baseline: null }));
      });
    return () => controller.abort();
  }, [upgradeNeed]);

  const startMeasuring = () => {
    updateSpaceCheck((c) => ({ ...c, measuring: true }));
  };

  const remeasure = (sizeBefore: number | undefined, after: CacheInfo | null) => {
    const next = updateSpaceCheck((c) => ({
      ...c,
      measuring: false,
      cleaned: true,
      free: after ? freeOn(after, c.need) : null,
      deleted: c.deleted + (after && sizeBefore !== undefined ? Math.max(0, sizeBefore - after.total_size) : 0),
    }));
    if (!next) return;
    const verdict = spaceVerdict(next);
    announce(verdict.kind === "enough"
      ? "Enough space is free now"
      : verdict.kind === "short"
        ? `${formatAtLeast(verdict.required - verdict.free)} still needed on ${next.need.mount}`
        : `Deleted ${formatSize(next.deleted)} of cache files`);
  };

  useEffect(() => {
    const controller = new AbortController();
    Promise.resolve().then(async () => {
      if (controller.signal.aborted) return;
      setLoading(true);
      try {
        const response = await getCacheInfo({
          offset: (page - 1) * perPage, limit: perPage, search: debouncedFilter,
          sortBy: activeSortKey ?? "name", sortDir: activeSortDirection, signal: controller.signal,
        });
        if (controller.signal.aborted) return;
        const lastPage = Math.max(1, Math.ceil(response.total / perPage));
        if (page > lastPage) { setPage(lastPage); return; }
        setCacheData(response);
        setLoadedFilter(debouncedFilter);
        setState(current => current === "loading" || current === "error" ? "ready" : current);
      } catch (ex) {
        if (!controller.signal.aborted) failLoad(ex);
      } finally {
        if (!controller.signal.aborted) setLoading(false);
      }
    });
    return () => controller.abort();
  }, [page, perPage, debouncedFilter, activeSortKey, activeSortDirection, refresh, setPage, failLoad]);

  const refreshCacheInfo = () => {
    if (stateRef.current !== "cleaning") setRefresh(value => value + 1);
  };

  useEffect(() => {
    stateRef.current = state;
  }, [state]);

  useRefreshOnActivate(() => {
    void refreshCacheInfo();
    void refreshDetails();
  });

  useEffect(() => {
    isMountedRef.current = true;
    return () => {
      isMountedRef.current = false;
      cancelRef.current?.();
    };
  }, []);

  useEffect(() => {
    if (detailsTarget) {
      fetchDetails(detailsTarget.name, detailsTarget.repo ? { strategy: "sync", repo: detailsTarget.repo } : { strategy: "local-then-sync" });
    } else {
      clearDetails();
    }
  }, [detailsTarget, fetchDetails, clearDetails]);

  useRouteOptionsSync(
    routeOptions,
    onRouteChange,
    { pkg: detailsTarget?.name, repo: detailsTarget?.repo },
    parseRoute,
    (options) => {
      if (!options.pkg) returnFocusToRow(detailsName, DETAILS_TRIGGER_ATTR);
      setDetailsTarget(options.pkg ? { name: options.pkg, repo: options.repo || undefined } : null);
    },
  );

  const handleRowClick = (pkgName: string) => {
    setDetailsTarget((current) => (current?.name === pkgName && !current.repo ? current : { name: pkgName }));
  };

  const closeDetails = () => setDetailsTarget(null);

  const handleCleanCache = () => {
    setPreviewEpoch(value => value + 1);
    setConfirmModalOpen(true);
  };

  const startCleanup = () => {
    if (cancelRef.current || cleanGate.reason || !hasSelection || loading || previewPending || !projected?.files || searchFilter !== debouncedFilter) return;
    setConfirmModalOpen(false);
    setState("cleaning");
    resetLog();
    setError(null);
    setErrorDetails(undefined);
    setErrorCode(undefined);
    setResultMessage(null);
    setStopAsked(false);
    setStopping(false);
    stoppingRef.current = false;
    setFinishedAfterStop(false);
    setCleanProgress(null);
    setIsDetailsExpanded(true);

    const run = ++cleanRunRef.current;
    const packages = selected;
    const sizeBefore = cacheData?.total_size;
    const measureAfterClean = () => {
      const need = upgradeNeedRef.current;
      if (!need) return;
      startMeasuring();
      getCacheInfo({ limit: 1 })
        .then((info) => {
          if (!isMountedRef.current || upgradeNeedRef.current !== need) return;
          remeasure(sizeBefore, info);
        })
        .catch(() => { if (isMountedRef.current && upgradeNeedRef.current === need) remeasure(sizeBefore, null); });
    };
    const finish = () => {
      cancelRef.current = null;
      stoppingRef.current = false;
      setStopping(false);
      setStopAsked(false);
    };
    const { cancel } = cleanCache(
      {
        onData: (data) => {
          if (isMountedRef.current && run === cleanRunRef.current) appendLog(data);
        },
        onEvent: (event) => {
          if (!isMountedRef.current || run !== cleanRunRef.current) return;
          if (event.type === "event" && event.current != null && event.total) {
            setCleanProgress({ current: event.current, total: event.total });
          }
          if (event.type === "complete" && event.message) setResultMessage(event.message);
        },
        onComplete: () => {
          if (!isMountedRef.current || run !== cleanRunRef.current) return;
          flushLog();
          setFinishedAfterStop(stoppingRef.current);
          finish();
          setState("success");
          setSelected({ mode: "all" });
          measureAfterClean();
        },
        onError: (err, code, details) => {
          if (!isMountedRef.current || run !== cleanRunRef.current) return;
          flushLog();
          setErrorCode(code);
          setErrorDetails(details);
          const wasStopping = stoppingRef.current;
          finish();
          if (wasStopping && code === "cancelled") {
            setResultMessage(err);
            setState("stopped");
            measureAfterClean();
            return;
          }
          setState("cleanError");
          setError(err);
          measureAfterClean();
        },
      },
      keepVersions,
      packages
    );
    cancelRef.current = cancel;
  };

  useEffect(() => {
    const target = stopFocusRef.current;
    stopFocusRef.current = null;
    if (target === "keep") keepRunningRef.current?.focus();
    else if (target === "stop") stopButtonRef.current?.focus();
  }, [stopAsked, stopping]);

  const askStop = () => {
    stopFocusRef.current = "keep";
    setStopAsked(true);
  };

  const answerStop = (stop: boolean) => {
    stopFocusRef.current = "stop";
    setStopAsked(false);
    if (!stop || !cancelRef.current) return;
    stoppingRef.current = true;
    setStopping(true);
    cancelRef.current();
  };

  const hasSelection = selection.all || selection.names.size > 0;
  const areAllSelected = selection.all && selection.names.size === 0;
  const areSomeSelected = hasSelection && !areAllSelected;
  const selectionSummary = areAllSelected ? null : selection.all
    ? "All packages except those deselected, including other pages"
    : `${plural(selection.names.size, "package")} selected across all pages`;
  const togglePackageSelection = (name: string) => setSelected(previous => {
    const names = new Set(previous.mode === "all" ? [] : previous.names);
    if (names.has(name)) names.delete(name); else names.add(name);
    return cacheSelection(previous.mode !== "only", names);
  });
  const previewKey = JSON.stringify([keepVersions, selected, refresh, previewEpoch]);
  const [preview, setPreview] = useState<{ key: string; value?: CleanupProjection; failure?: LoadFailure } | null>(null);
  const projected = preview?.key === previewKey ? preview.value : undefined;
  const previewFailure = preview?.key === previewKey ? preview.failure : undefined;
  const previewPending = !projected && !previewFailure;
  useEffect(() => {
    if (!confirmModalOpen && !upgradeNeed) return;
    const controller = new AbortController();
    previewCacheCleanup(keepVersions, selected, controller.signal).then(
      value => { if (!controller.signal.aborted) setPreview({ key: previewKey, value }); },
      error => { if (!controller.signal.aborted) setPreview({ key: previewKey, failure: toLoadFailure(error) }); },
    );
    return () => controller.abort();
  }, [confirmModalOpen, upgradeNeed, keepVersions, selected, previewKey]);
  const adviceKey = JSON.stringify([selected, refresh]);
  const [advice, setAdvice] = useState<{ key: string; values: ReadonlyMap<number, CleanupProjection> } | null>(null);
  useEffect(() => {
    if (!upgradeNeed?.holds_cache) return;
    const controller = new AbortController();
    Promise.all([2, 1].map(async keep => [keep, await previewCacheCleanup(keep, selected, controller.signal)] as const)).then(
      values => { if (!controller.signal.aborted) setAdvice({ key: adviceKey, values: new Map(values) }); },
      () => {},
    );
    return () => controller.abort();
  }, [upgradeNeed, selected, adviceKey]);
  const handleKeepVersionsChange = (value: number) => {
    announceProjectionRef.current = true;
    setKeepVersions(value);
  };
  useEffect(() => {
    if (!projected || !announceProjectionRef.current) return;
    announceProjectionRef.current = false;
    announce(projected.files > 0 ? `Frees up to ${formatSize(projected.bytes)} (${filesLabel(projected.files)})`
      : "Nothing to delete at this setting.");
  }, [projected, announce]);
  useResultAnnouncement(
    cacheData?.total === 0 ? `No cached packages match ${searchFilter}` : plural(cacheData?.total ?? 0, "cached package"),
    loadedFilter === null ? "" : debouncedFilter === searchFilter && loadedFilter === searchFilter && !loading ? searchFilter : null,
  );

  const check = upgradeNeed ? (spaceCheck?.need === upgradeNeed ? spaceCheck : newSpaceCheck(upgradeNeed)) : null;
  const verdict = check ? spaceVerdict(check) : null;
  const enoughFree = verdict?.kind === "enough";
  const resumeAsPrimary = state === "success" && enoughFree && !!onBackToUpgrade;
  const resumeGate = useMutationGate("upgrade packages", { permission: canAdminister });
  const resumeButtonRef = useRef<React.ComponentRef<"button">>(null);
  const resumeWasPrimaryRef = useRef(false);
  useEffect(() => {
    if (resumeAsPrimary && !resumeWasPrimaryRef.current) resumeButtonRef.current?.focus();
    resumeWasPrimaryRef.current = resumeAsPrimary;
  }, [resumeAsPrimary]);

  const blocked = onBackToUpgrade ? "upgrade" : "transaction";
  const recheck = onBackToUpgrade
    ? "Back to upgrade checks the space again before anything is installed."
    : "Start it again once there is room; it checks the space again before anything changes.";
  const showResumeLink = !!onBackToUpgrade && !resumeAsPrimary;
  const showReviewOrphans = !!upgradeNeed?.holds_cache && !!onViewOrphans && !enoughFree;
  const cleanButtonRef = useRef<React.ComponentRef<"button">>(null);
  const stillNeeded = upgradeNeed?.holds_cache && check && verdict && !check.measuring && state === "ready"
    ? verdict.kind === "short"
      ? verdict.required - verdict.free
      : verdict.kind === "unmeasured" && !check.cleaned ? upgradeNeed.deficit : null
    : null;
  const keepAdvice = (() => {
    if (stillNeeded === null || !hasSelection || advice?.key !== adviceKey) return null;
    const preset = keepFreeing(advice.values, stillNeeded);
    if (keepVersions >= 1 && projected && projected.bytes >= stillNeeded && keepVersions >= (preset ?? 0)) {
      return { keep: keepVersions, frees: projected.bytes, isSet: true };
    }
    if (preset !== null) return { keep: preset, frees: advice.values.get(preset)!.bytes, isSet: false };
    return { keep: null, frees: advice.values.get(1)?.bytes ?? 0, isSet: false };
  })();
  const ofSelection = areAllSelected ? "" : " of the selected packages";
  const keepSentence = keepAdvice
    ? keepAdvice.keep === null
      ? `Even keeping 1 version${ofSelection} frees only ${formatSize(keepAdvice.frees)}.`
      : `Keeping ${plural(keepAdvice.keep, "version")}${ofSelection} frees ${formatSize(keepAdvice.frees)}, enough for the ${blocked}.`
    : null;
  const keepPreset = keepAdvice && !keepAdvice.isSet ? keepAdvice.keep : null;
  const applyKeepPreset = (keep: number) => {
    handleKeepVersionsChange(keep);
    cleanButtonRef.current?.focus();
  };
  const upgradeNeedAlert = upgradeNeed && check && verdict ? (
    <Alert
      variant={enoughFree ? "success" : "info"}
      isInline
      className="pf-v6-u-mb-md"
      title={check.measuring
        ? "Measuring free space…"
        : verdict.kind === "enough"
          ? "Enough space is free now"
          : verdict.kind === "short" && check.cleaned
            ? `${formatAtLeast(verdict.required - verdict.free)} still needed on ${upgradeNeed.mount}`
            : verdict.kind === "unmeasured" && check.deleted > 0
              ? `Deleted ${formatSize(check.deleted)} of cache files`
              : `The ${blocked} needs ${formatAtLeast(upgradeNeed.deficit)} more on ${upgradeNeed.mount}`}
      actionClose={onDismissUpgradeNeed && (
        <AlertActionCloseButton aria-label="Dismiss the space need" onClose={onDismissUpgradeNeed} />
      )}
      actionLinks={(keepPreset !== null || showResumeLink || showReviewOrphans) && (
        <>
          {keepPreset !== null && (
            <AlertActionLink onClick={() => applyKeepPreset(keepPreset)}>
              Keep {plural(keepPreset, "version")}
            </AlertActionLink>
          )}
          {showResumeLink && (
            <GatedButton gate={resumeGate} variant="link" isInline onClick={onBackToUpgrade}>
              Back to upgrade
            </GatedButton>
          )}
          {showReviewOrphans && <AlertActionLink onClick={() => onViewOrphans()}>Review orphans</AlertActionLink>}
        </>
      )}
    >
      {check.measuring
        ? null
        : verdict.kind === "unmeasured"
          ? check.cleaned
            ? `Free space on ${upgradeNeed.mount} could not be measured. ${recheck}`
            : `${keepSentence ?? "Clean old package versions to free it."} ${recheck}`
          : `${upgradeNeed.mount} now has ${formatSize(verdict.free)} free; the ${blocked} needs ${formatAtLeast(verdict.required)}. `
            + (verdict.kind === "short" ? `${keepSentence ?? "Clean old package versions to free the rest."} ` : "")
            + recheck}
    </Alert>
  ) : null;

  if (loading && !cacheData) {
    return (
      <Card>
        <CardBody>
          <EmptyState headingLevel="h2" icon={Spinner} titleText="Loading cache information">
            <EmptyStateBody>Scanning package cache…</EmptyStateBody>
          </EmptyState>
        </CardBody>
      </Card>
    );
  }

  if (state === "cleanError") {
    return (
      <Card>
        <CardBody>
          <EmptyState headingLevel="h2" icon={ExclamationCircleIcon} titleText="Cache clean failed" status="danger">
            <EmptyStateBody>{sanitizeErrorMessage(error)}<ErrorDetails details={errorDetails} /></EmptyStateBody>
            <EmptyStateFooter>
              <EmptyStateActions>
                <Button variant="primary" onClick={loadCacheInfo}>Back to cache</Button>
              </EmptyStateActions>
            </EmptyStateFooter>
          </EmptyState>
          {log && <LogViewer log={log} className="pf-v6-u-mt-md" />}
        </CardBody>
      </Card>
    );
  }

  if (state === "error") {
    return (
      <Card>
        <CardBody>
          <LoadErrorState what="cache information" error={error} code={errorCode} details={errorDetails} onRetry={loadCacheInfo} />
        </CardBody>
      </Card>
    );
  }

  if (state === "cleaning") {
    return (
      <Card>
        <CardBody>
          <Flex justifyContent={{ default: "justifyContentSpaceBetween" }} alignItems={{ default: "alignItemsCenter" }}>
            <FlexItem>
              <CardTitle className="pf-v6-u-m-0">Cleaning package cache</CardTitle>
            </FlexItem>
            {!stopAsked && (
              <FlexItem>
                <Button
                  ref={stopButtonRef}
                  variant="secondary"
                  onClick={askStop}
                  isAriaDisabled={stopping}
                  isLoading={stopping}
                >
                  {stopping ? "Stopping…" : "Stop"}
                </Button>
              </FlexItem>
            )}
          </Flex>

          {stopAsked && (
            <Alert variant="warning" isInline id={stopQuestionId} title="Stop cleaning the cache?" className="pf-v6-u-mt-md">
              <Content component={ContentVariants.p}>Files already deleted stay deleted.</Content>
              <Flex spaceItems={{ default: "spaceItemsSm" }}>
                <Button variant="danger" onClick={() => answerStop(true)} aria-describedby={stopQuestionId}>
                  Stop cleaning
                </Button>
                <Button variant="link" ref={keepRunningRef} onClick={() => answerStop(false)} aria-describedby={stopQuestionId}>
                  Keep running
                </Button>
              </Flex>
            </Alert>
          )}

          {stopping && (
            <div className="pf-v6-u-mt-md">
              <p>Waiting for the cache cleanup process to exit. Files already deleted stay deleted.</p>
            </div>
          )}

          {cleanProgress ? (
            <Progress
              className="pf-v6-u-mt-md pf-v6-u-mb-md"
              value={Math.floor((cleanProgress.current / cleanProgress.total) * 100)}
              title={`Deleting old package files (keeping ${plural(keepVersions, "version")})`}
              measureLocation={ProgressMeasureLocation.outside}
              valueText={`${cleanProgress.current.toLocaleString()} of ${filesLabel(cleanProgress.total)}`}
            />
          ) : (
            <div className="pf-v6-u-mt-md pf-v6-u-mb-md">
              <Spinner size="md" aria-hidden /> Cleaning cache (keeping {plural(keepVersions, "version")})…
            </div>
          )}

          <ExpandableLogViewer
            log={log}
            placeholder="Starting…"
            isExpanded={isDetailsExpanded}
            onToggle={setIsDetailsExpanded}
          />
        </CardBody>
      </Card>
    );
  }

  if (state === "stopped") {
    return (
      <Card>
        <CardBody>
          {upgradeNeedAlert}
          <EmptyState headingLevel="h2" icon={InfoCircleIcon} titleText="Cache cleaning stopped">
            <EmptyStateBody>{resultMessage}</EmptyStateBody>
            <EmptyStateFooter>
              <EmptyStateActions>
                <Button variant="primary" onClick={loadCacheInfo}>Back to cache</Button>
              </EmptyStateActions>
            </EmptyStateFooter>
          </EmptyState>
          {log && <LogViewer log={log} className="pf-v6-u-mt-md" />}
        </CardBody>
      </Card>
    );
  }

  if (state === "success") {
    return (
      <Card>
        <CardBody>
          {upgradeNeedAlert}
          <EmptyState headingLevel="h2" icon={CheckCircleIcon} titleText="Cache cleaned">
            <EmptyStateBody>
              {finishedAfterStop && "Cleaning finished before it could be stopped. "}
              {resultMessage ?? "Old package versions have been removed from the cache."}
            </EmptyStateBody>
            <EmptyStateFooter>
              {resumeAsPrimary && (
                <EmptyStateActions>
                  <GatedButton ref={resumeButtonRef} gate={resumeGate} variant="primary" onClick={onBackToUpgrade}>
                    Back to upgrade
                  </GatedButton>
                </EmptyStateActions>
              )}
              <EmptyStateActions>
                <Button variant={resumeAsPrimary ? "secondary" : "primary"} onClick={loadCacheInfo}>
                  Back to cache
                </Button>
              </EmptyStateActions>
            </EmptyStateFooter>
          </EmptyState>
          {log && <LogViewer log={log} className="pf-v6-u-mt-md" />}
        </CardBody>
      </Card>
    );
  }

  if (!cacheData?.package_count) {
    return (
      <Card>
        <CardBody>
          {upgradeNeedAlert}
          <EmptyState headingLevel="h2" icon={FolderIcon} titleText="Cache is empty">
            <EmptyStateBody>
              The package cache at {cacheData?.path || "/var/cache/pacman/pkg"} contains no packages.
            </EmptyStateBody>
            <EmptyStateFooter>
              <EmptyStateActions>
                <Button variant="secondary" onClick={loadCacheInfo}>
                  Check again
                </Button>
              </EmptyStateActions>
            </EmptyStateFooter>
          </EmptyState>
        </CardBody>
      </Card>
    );
  }

  return (
    <>
    <Card className="pf-v6-u-mb-md">
      <CardBody>
        <Flex spaceItems={{ default: "spaceItemsLg" }}>
          <FlexItem>
            <StatBox
              label="Total size"
              value={formatSize(cacheData.total_size)}
            />
          </FlexItem>
          <FlexItem>
            <StatBox
              label="Cached files"
              value={(cacheData.package_count).toLocaleString()}
            />
          </FlexItem>
          <FlexItem>
            <StatBox
              label="Unique packages"
              value={(cacheData.unique_packages).toLocaleString()}
            />
          </FlexItem>
          <FlexItem>
            <StatBox
              label="Multi-Version"
              value={(cacheData.multi_version_packages).toLocaleString()}
              color={cacheData.multi_version_packages > 0 ? "info" : "default"}
            />
          </FlexItem>
        </Flex>
      </CardBody>
    </Card>
    <Card>
      <CardBody>

        {upgradeNeedAlert}

        <Toolbar>
          <ToolbarContent>
            <ToolbarItem>
              Cache directory{" "}
              <HelpPopover
                label="the cache directory"
                header="Cache directory"
                body={cacheData.path}
              />
            </ToolbarItem>
            <ToolbarItem>
              <SearchInput
                placeholder="Filter cached packages…"
                value={searchFilter}
                onChange={(_event, value) => { setSearchFilter(value); resetPage(); }}
                onClear={() => { setSearchFilter(""); resetPage(); }}
                aria-label="Filter cached packages"
              />
            </ToolbarItem>
            <ToolbarItem>
              <GatedButton
                ref={cleanButtonRef}
                gate={cleanGate}
                disabledReason={!hasSelection ? "Select at least one package" : loading || searchFilter !== debouncedFilter ? "Wait for the cache list to load" : null}
                variant="secondary"
                icon={<TrashIcon />}
                onClick={handleCleanCache}
              >
                {hasSelection && !areAllSelected ? "Clean selected packages" : "Clean cache"}
              </GatedButton>
            </ToolbarItem>
            <ToolbarItem><Button variant="plain" onClick={loadCacheInfo} isDisabled={loading}>Refresh</Button></ToolbarItem>
            {selectionSummary && (
              <ToolbarItem alignSelf="center">
                <Content component={ContentVariants.small}>{selectionSummary}</Content>
              </ToolbarItem>
            )}
            <ToolbarItem variant="pagination" align={{ default: "alignEnd" }}>
              <CompactPagination
                itemCount={cacheData.total}
                perPage={perPage}
                page={page}
                onSetPage={onSetPage}
                onPerPageSelect={onPerPageSelect}
              />
            </ToolbarItem>
          </ToolbarContent>
        </Toolbar>

        {loading && <Spinner size="md" aria-label="Loading cached packages" />}
        <PackageDetailsDrawer
          activeKey={detailsName}
          packageDetails={selectedPackage}
          isLoading={detailsLoading}
          onClose={closeDetails}
          error={detailsError}
          errorCode={detailsErrorCode}
          errorDetails={detailsErrorContext}
          isRemoved={detailsRemoved}
        >
        <PackageRowActionsProvider>
        <Table aria-label="Cached packages" variant="compact" aria-busy={loading}>
          <Thead>
            <Tr>
              <Th screenReaderText="Select">
                <Checkbox
                  id="select-all-cache"
                  isChecked={areAllSelected ? true : areSomeSelected ? null : false}
                  // PF's mixed checkbox keeps its previous DOM value.
                  onChange={() => setSelected(areAllSelected ? { mode: "only", names: [] } : { mode: "all" })}
                  aria-label="Select all packages"
                />
              </Th>
              <Th sort={getSortParams(0)}>Package</Th>
              <Th sort={getSortParams(1)}>Version</Th>
              <Th sort={getSortParams(2)}>Size</Th>
              <Th screenReaderText="Actions" />
            </Tr>
          </Thead>
          <Tbody>
            {cacheData.total === 0 && searchFilter && (
              <Tr>
                <Td colSpan={5}>
                  <EmptyState headingLevel="h3" icon={SearchIcon} titleText="No matching packages" variant="sm">
                    <EmptyStateBody>No cached package name contains <strong>{searchFilter}</strong>.</EmptyStateBody>
                    <EmptyStateFooter>
                      <EmptyStateActions>
                        <Button variant="link" onClick={() => { setSearchFilter(""); resetPage(); }}>
                          Clear filter
                        </Button>
                      </EmptyStateActions>
                    </EmptyStateFooter>
                  </EmptyState>
                </Td>
              </Tr>
            )}
            {cacheData.groups.map((group) => {
              const isSelected = selection.all !== selection.names.has(group.name);
              const installed = group.installed_version;
              return (
              <Tr
                key={group.name}
                isClickable
                onRowClick={() => handleRowClick(group.name)}
                isRowSelected={isSelected}
                {...detailsRowProps(detailsName === group.name)}
              >
                <RowSelectCell
                  label={`Select ${group.name}`}
                  isSelected={isSelected}
                  onSelect={() => togglePackageSelection(group.name)}
                />
                <Td dataLabel="Package">
                  <Button variant="link" isInline className="pf-v6-u-p-0" {...{ [DETAILS_TRIGGER_ATTR]: group.name }}>
                    {group.name}
                  </Button>
                </Td>
                <Td dataLabel="Version">
                  <div>{group.latest_version}</div>
                  {installed && <Label isCompact color="blue">{installed} installed</Label>}
                  <Button variant="link" isInline aria-label={`View cached files for ${group.name}`}
                    onClick={event => { event.stopPropagation(); setFilesPackage(group.name); }}>
                    {filesLabel(group.file_count)}
                  </Button>
                </Td>
                <Td dataLabel="Size">{formatSize(group.total_size)}</Td>
                <Td
                  isActionCell
                  onClick={(e) => e.stopPropagation()}
                  onKeyDown={(e) => {
                    if (e.key === "Enter" || e.key === " ") e.stopPropagation();
                  }}
                >
                  <PackageRowActions
                    name={group.name}
                    installedVersion={installed}
                    downgradeTo={group.downgrade_version}
                    onViewDetails={() => handleRowClick(group.name)}
                  />
                </Td>
              </Tr>
              );
            })}
          </Tbody>
        </Table>
        </PackageRowActionsProvider>
        <Toolbar>
          <ToolbarContent>
            <ToolbarItem variant="pagination" align={{ default: "alignEnd" }}>
              <CompactPagination
                itemCount={cacheData.total}
                perPage={perPage}
                page={page}
                onSetPage={onSetPage}
                onPerPageSelect={onPerPageSelect}
              />
            </ToolbarItem>
          </ToolbarContent>
        </Toolbar>
        </PackageDetailsDrawer>
      </CardBody>

      <ConfirmModal
        isOpen={confirmModalOpen}
        title="Clean package cache?"
        severity={keepVersions === 0 ? "danger" : "warning"}
        commitLabel={previewPending ? "Calculating cleanup…" : projected?.files
          ? `Delete up to ${filesLabel(projected.files)} (${formatSize(projected.bytes)})`
          : "Nothing to delete"}
        gate={cleanGate}
        commitDisabled={previewPending || !projected?.files || !hasSelection || loading || searchFilter !== debouncedFilter}
        onConfirm={startCleanup}
        onClose={() => setConfirmModalOpen(false)}
      >
        <Content>
          <Content component={ContentVariants.p}>
            {areAllSelected ? "This will remove old versions of all cached packages, keeping only the most recent versions."
              : selection.all ? "This will clean all cached packages except those you deselected."
              : "This will clean only the packages you selected."}
          </Content>
          {selectionSummary && (
            <Content component={ContentVariants.p}>
              The selection includes packages on other pages or hidden by the filter.
            </Content>
          )}
          <div className="pf-v6-u-mt-md pf-v6-u-mb-sm">
            <strong>Versions to keep:</strong>{" "}
            <HelpPopover
              label="versions to keep"
              header="How many versions to keep"
              body="0 deletes all cached packages, including the currently installed ones. 1 or more keeps the N most recent versions of each package, letting you downgrade later without re-downloading."
            />
          </div>
          <Slider
            value={keepVersions}
            onChange={(_event, value) => handleKeepVersionsChange(value)}
            thumbAriaLabel="Versions to keep"
            min={0}
            max={5}
            showTicks
            customSteps={[
              { value: 0, label: "0" },
              { value: 1, label: "1" },
              { value: 2, label: "2" },
              { value: 3, label: "3" },
              { value: 4, label: "4" },
              { value: 5, label: "5" },
            ]}
          />
          <Content component={ContentVariants.p} className="pf-v6-u-mt-md">
            {keepVersions === 0
              ? "All cached versions of the selected packages will be deleted, including installed versions."
              : `The ${plural(keepVersions, "most recent version")} of each selected package will be kept.`}
          </Content>
          <Content component={ContentVariants.p}>
            {previewPending ? "Calculating cleanup…" : projected?.files
              ? <>Frees up to <strong>{formatSize(projected.bytes)}</strong> ({filesLabel(projected.files)})</>
              : previewFailure ? null : "Nothing to delete at this setting."}
          </Content>
          {previewFailure && <ErrorAlert title="Could not preview cleanup" error={previewFailure.message}
            code={previewFailure.code} details={previewFailure.details} showRetry onRetry={() => setRefresh(value => value + 1)} />}
        </Content>
      </ConfirmModal>
      {filesPackage !== null && <CacheFilesModal name={filesPackage} onClose={() => setFilesPackage(null)} />}
    </Card>
    </>
  );
};
