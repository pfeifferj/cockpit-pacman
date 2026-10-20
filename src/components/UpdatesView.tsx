import React, { useState, useEffect, useCallback, useRef, useMemo } from "react";
import { ARCH_STATUS_URL, REBOOT_PACKAGES } from "../constants";
import { useBackdropClose } from "../hooks/useBackdropClose";
import { usePackageDetails } from "../hooks/usePackageDetails";
import { useSortableTable } from "../hooks/useSortableTable";
import { usePagination } from "../hooks/usePagination";
import { useSignatureDismissal } from "../hooks/useSignatureDismissal";
import { useStreamingLog } from "../hooks/useStreamingLog";
import { useArchNews } from "../hooks/useArchNews";
import { useAdminPermission } from "../hooks/useAdminPermission";
import { mutationGate, useMutationGate } from "../hooks/useMutationGate";
import { GatedButton, useGateTooltip } from "./GatedButton";
import { useSecurityAdvisories } from "../hooks/useSecurityAdvisories";
import { usePageVisible } from "../hooks/usePageVisible";
import { useRefreshOnActivate, useTabActive } from "../hooks/useRefreshOnActivate";
import { useRouteOptionsSync, type RouteOptions } from "../hooks/useRoute";
import { describeUpgrade, formatTotalsLine, needsUpgradeConfirm, selectionTotals, removalNames, upgradeCounts, type UpgradeCounts } from "../transactionTotals";
import {
	Card,
	CardBody,
	CardHeader,
	SkipToContent,
	CardTitle,
	Button,
	Alert,
	AlertActionCloseButton,
	AlertActionLink,
	AlertGroup,
	EmptyState,
	EmptyStateBody,
	EmptyStateActions,
	EmptyStateFooter,
	ExpandableSection,
	Spinner,
	Progress,
	ProgressMeasureLocation,
	Flex,
	FlexItem,
	SearchInput,
	Toolbar,
	ToolbarContent,
	ToolbarItem,
	Label,
	MenuToggle,
	MenuToggleElement,
	Select,
	SelectOption,
	SelectList,
	List,
	ListItem,
	Content,
	ContentVariants,
	Checkbox,
	Tooltip,
} from '@patternfly/react-core';
import { ExpandableLogViewer, LogViewer } from './LogViewer';
import { ConfirmModal } from './ConfirmModal';
import { TidyUpModal } from './TidyUpModal';
import { ConfigReconciliationModal } from './ConfigReconciliationModal';
import { DEFAULT_KEEP_VERSIONS, type CleanupProjection } from '../cacheProjection';
import { KeyringWarnings, WarningsAlert } from './KeyringView';
import { initialProgress, progressPercent, progressValueText, reduceProgress, ProgressPlan, ProgressState } from '../progress';
import {
  CheckCircleIcon,
  ExclamationCircleIcon,
  SyncAltIcon,
  ArrowUpIcon,
  ArrowDownIcon,
  PowerOffIcon,
  ExclamationTriangleIcon,
} from "@patternfly/react-icons";
import { Table, Thead, Tr, Th, Tbody, Td } from "@patternfly/react-table";
import {
  UpdateInfo,
  type SystemChangeKind,
  PreflightResponse,
  StreamEvent,
  RebootStatus,
  PacnewStatus,
  ServiceRestart,
  ServicesStatus,
  KeyringStatusResponse,
  checkUpdates,
  getActiveTransaction,
  runUpgrade,
  syncDatabase,
  preflightUpgrade,
  formatSize,
  getRebootStatus,
  rebootSystem,
  getServicesStatus,
  restartServices,
  listOrphans,
  getCacheInfo,
  previewCacheCleanup,
  getKeyringStatus,
  servicesDismissal,
  rebootDismissal,
  getPacnewStatus,
  pacnewDismissal,
  getScheduledRuns,
  scheduledDismissal,
  addIgnoredPackage,
  removeIgnoredPackage,
  getSignoffList,
  parseErrorCode,
  BackendError,
  onSystemChanged,
} from "../api";
import type { KeyringCredentials, ErrorCode, ScheduledRunEntry, StreamingHandle } from "../api";
import { NetworkErrorState } from "./NetworkErrorState";
import { ErrorDetails } from "./ErrorDetails";
import { CompactPagination } from "./CompactPagination";

import { ignoreNotice, isDbLockError, plural, sanitizeUrl } from "../utils";
import { TimeAgo } from "./TimeAgo";
import { PackageDetailsDrawer, DETAILS_TRIGGER_ATTR, detailsRowProps } from "./PackageDetailsDrawer";
import { PackageRowActions, PackageRowActionsProvider, fromRowActions } from "./PackageRowActions";
import { SystemOverviewCard } from "./SystemOverviewCard";
import { countToSignOff } from "./SignoffsView";
import { LockErrorBody, HOST_RETRY_HIDDEN, type LockWaitState } from "./LockErrorBody";
import { CancellationNotice } from "./CancellationNotice";
import { AdvisoryPopover } from "./AdvisoryPopover";
import { highestOf, partitionAdvisories } from "../security";
import { IgnoredPackagesModal } from "./IgnoredPackagesModal";
import { ScheduleModal } from "./ScheduleModal";
import { PreflightConfirmModal } from "./PreflightConfirmModal";
import { RowSelectCell } from "./RowSelectCell";
import { NavigationProvider, useNavigation, type CacheContext } from "../contexts/NavigationContext";
import { useAnnounce } from "../contexts/AnnouncerContext";
import { formatRelativeTime } from "../timeFormat";

type PageStatus = {
  type?: "info" | "warning" | "error" | null;
  title: string;
  details?: { pficon?: string; link?: false };
};

function publishPageStatus(status: PageStatus | null): void {
  cockpit.transport.control("notify", { page_status: status });
}

// Unix seconds. lastSyncAt is when the databases were last synced, from
// pacman.log; oldestDatabaseAt is the oldest database file's mtime, which
// libalpm sets to the mirror's build time, and is null while any enabled
// repository has never been synced.
interface DatabaseTimes {
  lastSyncAt: number | null;
  oldestDatabaseAt: number | null;
}

const NO_DATABASE_TIMES: DatabaseTimes = { lastSyncAt: null, oldestDatabaseAt: null };

function databaseTimesOf(response: { last_sync_at: number | null; oldest_database_at: number | null }): DatabaseTimes {
  return { lastSyncAt: response.last_sync_at, oldestDatabaseAt: response.oldest_database_at };
}

function relativeAge(seconds: number): string {
  return formatRelativeTime(new Date(seconds * 1000));
}

function databaseAge(times: DatabaseTimes, checked: string, from: string): React.ReactNode {
  return times.lastSyncAt !== null
    ? <>{checked} <TimeAgo timestamp={times.lastSyncAt} /></>
    : <>{from} <TimeAgo timestamp={times.oldestDatabaseAt} /></>;
}

function upToDateTitle(_admin: boolean | null, times: DatabaseTimes): string {
  if (times.oldestDatabaseAt === null) return "Some package databases have never been synced";
  return times.lastSyncAt !== null
    ? `No updates when last checked ${relativeAge(times.lastSyncAt)}`
    : `No updates in package databases from ${relativeAge(times.oldestDatabaseAt)}`;
}

function upToDateHeading(admin: boolean | null, times: DatabaseTimes): React.ReactNode {
  if (times.oldestDatabaseAt === null) return upToDateTitle(admin, times);
  return databaseAge(times, "No updates when last checked", "No updates in package databases from");
}

function effectiveBlock(svc: ServiceRestart, isLocal: boolean): ServiceRestart["restart_blocked"] {
  return svc.restart_blocked === "cockpit_transport" && isLocal
    ? undefined
    : svc.restart_blocked;
}

const COLLAPSED_NAME_LIMIT = 5;

const CollapsedNames: React.FC<{ names: string[]; noun: string }> = ({ names, noun }) => {
  const [expanded, setExpanded] = useState(false);
  const listRef = useRef<HTMLElement>(null);
  const hidden = names.length - COLLAPSED_NAME_LIMIT;
  // The toggle unmounts on expand, so focus moves to the full list instead of falling to the body.
  useEffect(() => {
    if (expanded) listRef.current?.focus();
  }, [expanded]);
  if (hidden <= 0) return <>{names.join(", ")}.</>;
  if (expanded) return <span ref={listRef} tabIndex={-1}>{names.join(", ")}.</span>;
  return (
    <>
      {names.slice(0, COLLAPSED_NAME_LIMIT).join(", ")}, and{" "}
      <Button variant="link" isInline aria-label={`${hidden.toLocaleString()} more ${noun}`} onClick={() => setExpanded(true)}>
        {hidden.toLocaleString()} more
      </Button>
      .
    </>
  );
};

type ViewState =
  | "loading"
  | "checking"
  | "uptodate"
  | "available"
  | "applying"
  | "success"
  | "notchecked"
  | "error";

export interface UpdateStatus {
  /** Pending updates the user can select (held rows excluded), or null while that is not known. */
  count: number | null;
  /** Selectable updates that install a security advisory's fixed version. */
  security: number;
  /** The last check or sync failed, so the count is unknown. */
  failed: boolean;
}

interface UpdatesViewProps {
  signoffCredentials?: KeyringCredentials | null;
  toSignOff?: number | null;
  onToSignOffCount?: (count: number) => void;
  onUpdateStatus?: (status: UpdateStatus) => void;
  /** Options of the updates route while it is the routed tab: `pkg` and `repo` name the open details. */
  routeOptions?: RouteOptions;
  onRouteChange?: (options: RouteOptions) => void;
}

interface DetailsTarget {
  name: string;
  repo?: string;
}

function parseRoute(options: RouteOptions): RouteOptions {
  return { pkg: options.pkg ?? "", repo: options.pkg ? options.repo ?? "" : "" };
}

type ErrorOrigin = "check" | "sync" | "preflight" | "upgrade";

const RETRY_LABELS: Record<ErrorOrigin, string> = {
  check: "Retry check",
  sync: "Retry sync",
  preflight: "Retry upgrade",
  upgrade: "Retry upgrade",
};

const ERROR_TITLES: Record<ErrorOrigin, string> = {
  check: "Error checking for updates",
  sync: "Sync failed",
  preflight: "Upgrade could not start",
  upgrade: "Upgrade failed",
};

function signedSize(bytes: number): string {
  if (bytes > 0) return `+${formatSize(bytes)}`;
  if (bytes < 0) return `−${formatSize(-bytes)}`;
  return formatSize(0);
}

type PostRunCheck = "reboot" | "services" | "pacnew" | "orphans";
type CheckState = "pending" | "done" | "failed";
type PostRunChecks = Record<PostRunCheck, CheckState>;

/** Title shared by a notice and the next step that covers it. */
const NOTICE_TITLE = {
  reboot: "System reboot recommended",
  services: "Running services need to be restarted",
  pacnew: "Configuration files need review",
} as const;

const pacnewNeedsReview = (status: PacnewStatus | null): status is PacnewStatus =>
  !!status && (status.has_pacnew || !!status.warnings?.length);

const pacnewTitle = (status: PacnewStatus) =>
  status.has_pacnew ? NOTICE_TITLE.pacnew : "Configuration files could not be fully checked";

const pacnewSummary = (status: PacnewStatus) => status.has_pacnew
  ? `${plural(status.files.length, "configuration file")} left by package changes ${status.files.length === 1 ? "needs" : "need"} review.`
  : "Some configuration paths could not be checked. The review lists them.";

const PacnewFileList: React.FC<{ files: PacnewStatus["files"] }> = ({ files }) => (
  <>
    <List>
      {files.slice(0, 5).map((f) => (
        <ListItem key={f.path}>
          <strong>{f.path}</strong>{f.package && ` (${f.package})`}
        </ListItem>
      ))}
    </List>
    {files.length > 5 && <p>And {files.length - 5} more.</p>}
  </>
);

const CHECK_COPY: Record<PostRunCheck, { checking: string; clear: string; failed: string }> = {
  reboot: {
    checking: "Checking whether a reboot is needed…",
    clear: "No reboot needed.",
    failed: "Could not check whether a reboot is needed.",
  },
  services: {
    checking: "Checking which services need a restart…",
    clear: "No running services need a restart.",
    failed: "Could not check which services need a restart.",
  },
  pacnew: {
    checking: "Checking for configuration files to merge…",
    clear: "No configuration files to merge.",
    failed: "Could not check for configuration files to merge.",
  },
  orphans: {
    checking: "Counting orphan packages…",
    clear: "The upgrade left no new orphan packages.",
    failed: "Could not count orphan packages.",
  },
};

const restartLabel = (count: number) => `Restart ${plural(count, "service")}`;
const restartedText = (units: string[]) => `Restarted ${units.join(", ")}`;

// cockpit.jump is absent from src/cockpit.d.ts.
const jumpToService = (unit: string) =>
  (cockpit as typeof cockpit & { jump(path: string): void }).jump(`/system/services#/${unit}`);

function rebootReason(status: RebootStatus | null): string {
  if (!status?.requires_reboot) return "";
  if (status.reason === "kernel_update" && status.installed_kernel && status.running_kernel) {
    return `${status.kernel_package ?? "linux"} ${status.installed_kernel} is installed; ${status.running_kernel} is running.`;
  }
  if (status.updated_packages.length > 0) {
    return `${status.updated_packages.join(", ")} ${status.updated_packages.length === 1 ? "was" : "were"} updated since boot.`;
  }
  return "";
}

function scheduledRunSummary(run: ScheduledRunEntry): string {
  if (run.status === "failed" || (run.status === "" && !run.success)) return "failed";
  if (run.status === "skipped") {
    const reason = (run.error || run.details[0] || "").replace(/^Skipped:\s*/i, "");
    return reason ? `skipped: ${reason}` : "skipped";
  }
  if (run.status === "unrecorded") return "outcome was not recorded";
  if ((run.packages_upgraded ?? 0) > 0) return `upgraded ${plural(run.packages_upgraded!, "package", "packages")}`;
  if ((run.packages_checked ?? 0) > 0) return `checked, ${plural(run.packages_checked!, "update", "updates")} available`;
  return "checked, no updates available";
}

// Rows a quiet refresh added this long before Apply force the confirm: the
// user may not have seen them arrive.
const LATE_ARRIVAL_MS = 2000;

function arrivedRecently(arrivedAt: number): boolean {
  return Date.now() - arrivedAt < LATE_ARRIVAL_MS;
}

const offeredVersions = (updates: UpdateInfo[]) =>
  updates.map((u) => `${u.name}@${u.current_version}:${u.new_version}`).sort().join(",");

// Treat held rows as unseen so releasing a hold selects the update.
function selectionAfterReload(prev: Set<string>, seen: Set<string>, updates: UpdateInfo[], initialized: boolean): Set<string> {
  return new Set(
    updates
      .filter((u) => !u.ignored && (!initialized || prev.has(u.name) || !seen.has(u.name)))
      .map((u) => u.name),
  );
}

interface ApplyOptions {
  /** Open the confirm even when the preflight matches the selection. */
  confirm?: boolean;
  /** A freshly read list and its selection, used before the state catches up. */
  list?: UpdateInfo[];
  selection?: Set<string>;
}

const SIGNATURE_HELP =
  "The package or its signing key is not trusted by the local keyring. Refreshing keys or updating archlinux-keyring usually fixes this. Do not disable signature checking.";

interface DismissToast {
  id: number;
  variant: "info" | "success" | "danger";
  title: string;
  body?: string;
  undo?: () => void;
  retry?: () => void;
}

const IgnoredLabel: React.FC<{ name: string; gate?: string; onOpen: () => void }> = ({ name, gate, onOpen }) => {
  const ref = useRef<React.ComponentRef<"button">>(null);
  const tip = useGateTooltip(gate);
  return (
    <>
      <Label
        color="orange"
        className="pf-v6-u-ml-sm"
        isCompact
        isClickable
        render={({ className, content }) => (
          <button
            type="button"
            ref={ref}
            className={className}
            aria-label={`${name} is ignored, manage ignored packages`}
            aria-disabled={gate ? true : undefined}
            aria-describedby={gate ? tip.id : undefined}
            {...tip.handlers}
            onClick={(e) => {
              e.stopPropagation();
              if (!gate) onOpen();
            }}
          >
            {content}
          </button>
        )}
      >
        ignored
      </Label>
      <Tooltip content={tip.content} triggerRef={ref} trigger="manual" isVisible={tip.isVisible} aria="none" />
      <span id={tip.id} className="pf-v6-screen-reader">{gate}</span>
    </>
  );
};

// Row dialogs outlive the table, which unmounts while the view loads or applies.
export const UpdatesView: React.FC<UpdatesViewProps> = (props) => (
  <PackageRowActionsProvider>
    <UpdatesViewContent {...props} />
  </PackageRowActionsProvider>
);

const UpdatesViewContent: React.FC<UpdatesViewProps> = ({
  signoffCredentials, toSignOff = null, onToSignOffCount, onUpdateStatus, routeOptions, onRouteChange,
}) => {
  const navigation = useNavigation();
  const { onViewDependencies, onViewHistory, onViewKeyring, onViewSignoffs, onViewOrphans } = navigation;
  const announce = useAnnounce();
  const [state, setState] = useState<ViewState>("loading");
  const [updates, setUpdates] = useState<UpdateInfo[]>([]);
  const { log, appendLog, flushLog, resetLog } = useStreamingLog();
  const [error, setError] = useState<string | null>(null);
  const [errorCode, setErrorCode] = useState<ErrorCode | undefined>(undefined);
  const [errorDetails, setErrorDetails] = useState<string | undefined>(undefined);
  const [warnings, setWarnings] = useState<string[]>([]);
  const cancelRef = useRef<StreamingHandle | null>(null);
  const [errorOrigin, setErrorOrigin] = useState<ErrorOrigin>("check");
  const autoResumedRef = useRef(false);
  const [lockRetryExhausted, setLockRetryExhausted] = useState(false);
  const [lockCleared, setLockCleared] = useState(false);
  const [resumeMissNotice, setResumeMissNotice] = useState<string | null>(null);
  const [resuming, setResuming] = useState(false);
  const [errorEpoch, setErrorEpoch] = useState(0);
  const [lockWaitState, setLockWaitState] = useState<LockWaitState>("checking");
  const adminAllowed = useAdminPermission();
  const refreshMutation = useMutationGate("sync the package databases", { permission: adminAllowed, owner: "updates" });
  const applyMutation = useMutationGate("apply updates", { permission: adminAllowed, owner: "updates" });
  const ignoredMutation = useMutationGate("manage ignored packages", { permission: adminAllowed, owner: "updates" });
  const ignoreMutation = useMutationGate("ignore packages", { permission: adminAllowed, owner: "updates" });
  const rebootMutation = useMutationGate("reboot the system", { permission: adminAllowed });
  const restartMutation = useMutationGate("restart services", { permission: adminAllowed });
  const tidyMutation = useMutationGate("remove orphan packages and clean the cache", { permission: adminAllowed });
  const reconciliationMutation = useMutationGate("review configuration files", { permission: adminAllowed });
  const { hasBeenVisible } = usePageVisible();
  const hasBeenVisibleRef = useRef(hasBeenVisible);
  const stateRef = useRef(state);
  const adminAllowedRef = useRef(adminAllowed);
  useEffect(() => {
    hasBeenVisibleRef.current = hasBeenVisible;
    stateRef.current = state;
    adminAllowedRef.current = adminAllowed;
  });
  const lastGoodRef = useRef<"available" | "uptodate" | null>(null);
  const [upgradeSummary, setUpgradeSummary] = useState<{ counts: UpgradeCounts; skipped: string[]; held: number }>({
    counts: { upgrade: 0, install: 0, remove: 0 },
    skipped: [],
    held: 0,
  });

  // Consecutive errors can commit in one render batch without ever showing
  // the intermediate state, so the epoch forces LockErrorBody to remount
  // (and re-check the lock) for each new error.
  const failWith = useCallback((origin: ErrorOrigin, message: string, code?: ErrorCode, details?: string) => {
    setErrorOrigin(origin);
    setError(message);
    setErrorCode(code);
    setErrorDetails(details);
    setErrorEpoch((e) => e + 1);
    setLockWaitState("checking");
    setState("error");
  }, []);
  const {
    selectedPackage, detailsLoading: packageLoading, detailsError, detailsErrorCode, detailsErrorContext, detailsRemoved, fetchDetails, refreshDetails, clearDetails,
  } = usePackageDetails();
  const [detailsTarget, setDetailsTarget] = useState<DetailsTarget | null>(() => {
    const initial = parseRoute(routeOptions ?? {});
    return initial.pkg ? { name: initial.pkg, repo: initial.repo || undefined } : null;
  });
  const detailsName = detailsTarget?.name ?? null;
  const [searchFilter, setSearchFilter] = useState("");
  const [repoFilter, setRepoFilter] = useState("all");
  const [securityFilterActive, setSecurityFilterActive] = useState(false);
  const [repoSelectOpen, setRepoSelectOpen] = useState(false);
  const [confirmModalOpen, setConfirmModalOpen] = useState(false);
  const [preflightData, setPreflightData] = useState<PreflightResponse | null>(null);
  const [preflightLoading, setPreflightLoading] = useState(false);
  const [previewRefreshing, setPreviewRefreshing] = useState(false);
  const preflightRequest = useRef(0);
  const systemRevision = useRef(0);
  const previewRevision = useRef(-1);
  const closePreflight = () => {
    preflightRequest.current++;
    setPreflightLoading(false);
    setPreviewRefreshing(false);
    setConfirmModalOpen(false);
  };
  useBackdropClose(confirmModalOpen, closePreflight);
  useEffect(() => () => { preflightRequest.current++; }, []);
  useEffect(() => onSystemChanged(() => { systemRevision.current++; }), []);
  useEffect(() => {
    if (state !== "applying") return;
    const warn = (event: Event) => event.preventDefault();
    window.addEventListener("beforeunload", warn);
    return () => window.removeEventListener("beforeunload", warn);
  }, [state]);
  const changedDuringPreflightRef = useRef(false);
  const [confirmOpensStale, setConfirmOpensStale] = useState(false);
  const queuedRefreshRef = useRef(false);
  const [selectedPackages, setSelectedPackages] = useState<Set<string>>(new Set());
  const [newNames, setNewNames] = useState<ReadonlySet<string>>(new Set());
  const lastArrivalRef = useRef(-Infinity);
  const [lastCheckedAt, setLastCheckedAt] = useState<number | null>(null);
  const [quietReloadFailed, setQuietReloadFailed] = useState(false);
  const [databaseTimes, setDatabaseTimes] = useState<DatabaseTimes>(NO_DATABASE_TIMES);
  const databaseTimesRef = useRef<DatabaseTimes>(NO_DATABASE_TIMES);
  const updatesRef = useRef(updates);
  const selectedRef = useRef(selectedPackages);
  useEffect(() => {
    updatesRef.current = updates;
    selectedRef.current = selectedPackages;
  });
  const applyButtonRef = useRef<React.ComponentRef<"button">>(null);
  const tableRef = useRef<React.ComponentRef<"table">>(null);
  const focusKebabRef = useRef<string | null>(null);
  const [upgradeProgress, setUpgradeProgress] = useState<ProgressState>(initialProgress);
  // Announced once per phase, not per item, so a screen reader is not flooded.
  const announcedPhaseRef = useRef<string | null>(null);
  useEffect(() => {
    if (state !== "applying") {
      announcedPhaseRef.current = null;
      return;
    }
    if (announcedPhaseRef.current === upgradeProgress.phase) return;
    announcedPhaseRef.current = upgradeProgress.phase;
    announce(upgradeProgress.phaseLabel);
  }, [state, upgradeProgress.phase, upgradeProgress.phaseLabel, announce]);

  const listHeaderRef = useRef<HTMLDivElement>(null);
  const [isDetailsExpanded, setIsDetailsExpanded] = useState(false);
  const [cancelModalOpen, setCancelModalOpen] = useState(false);
  useBackdropClose(cancelModalOpen, () => setCancelModalOpen(false));
  const [isCancelling, setIsCancelling] = useState(false);
  // Ref mirror for the upgrade callbacks, which close over stale state.
  const isCancellingRef = useRef(false);
  const [cancelOutcome, setCancelOutcome] = useState<{ kind: "stopped" | "finished"; detail?: string } | null>(null);
  const setCancelling = (value: boolean) => {
    isCancellingRef.current = value;
    setIsCancelling(value);
  };
  const [ignoredModalOpen, setIgnoredModalOpen] = useState(false);
  const [ignoredModalFocus, setIgnoredModalFocus] = useState<string | undefined>(undefined);
  const openIgnoredModal = (name?: string) => {
    setIgnoredModalFocus(name);
    setIgnoredModalOpen(true);
  };
  const [scheduleModalOpen, setScheduleModalOpen] = useState(false);
  const [scheduleHistoryOnOpen, setScheduleHistoryOnOpen] = useState(false);
  const [rebootStatus, setRebootStatus] = useState<RebootStatus | null>(null);
  const [rebootOnComplete, setRebootOnComplete] = useState(false);
  const [rebootConfirmOpen, setRebootConfirmOpen] = useState(false);
  useBackdropClose(rebootConfirmOpen, () => setRebootConfirmOpen(false));
  const [rebootError, setRebootError] = useState<string | null>(null);
  const [servicesStatus, setServicesStatus] = useState<ServicesStatus | null>(null);
  const [restartServicesOnComplete, setRestartServicesOnComplete] = useState(false);
  // The upgrade callbacks are created when it starts, before either box can be ticked.
  const optInRef = useRef({ reboot: false, restart: false });
  useEffect(() => {
    optInRef.current = { reboot: rebootOnComplete, restart: restartServicesOnComplete };
  });
  const [pacnewStatus, setPacnewStatus] = useState<PacnewStatus | null>(null);
  const [reconciliationOpen, setReconciliationOpen] = useState(false);
  const [latestScheduledRun, setLatestScheduledRun] = useState<ScheduledRunEntry | null>(null);

  const servicesSignature = useMemo(
    () => (servicesStatus?.services ?? []).map((s) => s.name).sort().join(","),
    [servicesStatus],
  );
  const rebootSignature = useMemo(() => {
    if (!rebootStatus?.requires_reboot) return "";
    if (rebootStatus.reason === "kernel_update" && rebootStatus.installed_kernel) {
      return `kernel:${rebootStatus.installed_kernel}`;
    }
    if (rebootStatus.reason === "critical_packages" && rebootStatus.updated_packages.length > 0) {
      return `critical:${[...rebootStatus.updated_packages].sort().join(",")}`;
    }
    return "";
  }, [rebootStatus]);
  const pacnewSignature = useMemo(() => {
    const files = (pacnewStatus?.files ?? []).map((f) => `${f.path}@${f.mtime}`).sort().join(",");
    const warnings = pacnewStatus?.warnings ?? [];
    return warnings.length ? `${files}\nscan-incomplete:${[...warnings].sort().join("\n")}` : files;
  }, [pacnewStatus]);
  const scheduledSignature = latestScheduledRun?.invocation_id ?? latestScheduledRun?.timestamp ?? "";
  const [scheduledHistoryWarning, setScheduledHistoryWarning] = useState<string | null>(null);

  const [toasts, setToasts] = useState<DismissToast[]>([]);
  const toastIdRef = useRef(0);
  const pushToast = useCallback((toast: Omit<DismissToast, "id">) => {
    toastIdRef.current += 1;
    const id = toastIdRef.current;
    setToasts((prev) => [...prev, { ...toast, id }]);
  }, []);
  const closeToast = useCallback((id: number) => {
    setToasts((prev) => prev.filter((t) => t.id !== id));
  }, []);
  const reportDismissalFailure = useCallback((err: unknown) => {
    pushToast({
      variant: "danger",
      title: "Could not save the dismissal",
      body: err instanceof Error ? err.message : String(err),
    });
  }, [pushToast]);

  const servicesNotice = useSignatureDismissal(servicesDismissal, servicesSignature, reportDismissalFailure);
  const rebootNotice = useSignatureDismissal(rebootDismissal, rebootSignature, reportDismissalFailure);
  const pacnewNotice = useSignatureDismissal(pacnewDismissal, pacnewSignature, reportDismissalFailure);
  const scheduledNotice = useSignatureDismissal(scheduledDismissal, scheduledSignature, reportDismissalFailure);
  const servicesUndismissed = servicesNotice.undismissed;
  const rebootUndismissed = rebootNotice.undismissed;
  const pacnewUndismissed = pacnewNotice.undismissed;
  const scheduledUndismissed = scheduledNotice.undismissed;
  const [orphanNames, setOrphanNames] = useState<string[] | null>(null);
  const orphanCount = orphanNames?.length ?? null;
  const [orphansBefore, setOrphansBefore] = useState<string[] | null>(null);
  const [postChecks, setPostChecks] = useState<PostRunChecks | null>(null);
  const postRunRef = useRef(0);
  const [restarting, setRestarting] = useState(false);
  const restartingRef = useRef(false);
  const [restarted, setRestarted] = useState<string[] | null>(null);
  const [cacheSize, setCacheSize] = useState<number | null>(null);
  const [cacheProjection, setCacheProjection] = useState<CleanupProjection | null>(null);
  const [tidyPlan, setTidyPlan] = useState<{ orphans: string[]; cache: CleanupProjection } | null>(null);
  const [keyringStatus, setKeyringStatus] = useState<KeyringStatusResponse | null>(null);
  const [summaryLoading, setSummaryLoading] = useState(true);
  const {
    advisories: securityMap,
    actionable: actionableSecurityMap,
    loading: securityLoading,
    stale: securityStale,
    unavailable: securityUnavailable,
    enabled: securityEnabled,
    toggleBusy: savingSecurityToggle,
    toggleError: securityToggleError,
    load: loadSecurityData,
    setEnabled: handleSetSecurityEnabled,
  } = useSecurityAdvisories();
  const {
    items: visibleNews,
    dismissedInWindow: dismissedNews,
    error: newsError,
    stale: newsStale,
    dismiss: dismissNewsItem,
    dismissAll: dismissAllNews,
    restore: restoreNewsItem,
    clearError: clearNewsError,
    reload: reloadNews,
  } = useArchNews(reportDismissalFailure, hasBeenVisible);
  const [showDismissed, setShowDismissed] = useState(false);
  const [noticesExpanded, setNoticesExpanded] = useState(false);

  const { activeSortKey, activeSortDirection, getSortParams } = useSortableTable({
    columns: { name: 1, repo: 2, download: 4, installed: 5, net: 6 },
    defaultDirection: "asc",
  });

  const repositories = useMemo(() => {
    const repos = new Set(updates.map((u) => u.repository));
    return Array.from(repos).sort();
  }, [updates]);

  const securityUpdateCount = useMemo(() => {
    return updates.filter((u) => actionableSecurityMap.has(u.name)).length;
  }, [updates, actionableSecurityMap]);

  // The filter only applies while there are security updates to show, so a
  // refresh that drops the count to zero never strands the list on an empty result.
  const securityFilterOn = securityFilterActive && securityUpdateCount > 0;

  const filteredUpdates = useMemo(() => {
    let result = updates;
    if (searchFilter) {
      const search = searchFilter.toLowerCase();
      result = result.filter(
        (u) =>
          u.name.toLowerCase().includes(search) ||
          u.current_version.toLowerCase().includes(search) ||
          u.new_version.toLowerCase().includes(search)
      );
    }
    if (repoFilter !== "all") {
      result = result.filter((u) => u.repository === repoFilter);
    }
    if (securityFilterOn) {
      result = result.filter((u) => actionableSecurityMap.has(u.name));
    }
    return result;
  }, [updates, searchFilter, repoFilter, securityFilterOn, actionableSecurityMap]);

  const sortedUpdates = useMemo(() => {
    if (activeSortKey === null) return filteredUpdates;

    return [...filteredUpdates].sort((a, b) => {
      let comparison = 0;
      switch (activeSortKey) {
        case "name":
          comparison = a.name.localeCompare(b.name);
          break;
        case "repo":
          comparison = a.repository.localeCompare(b.repository);
          break;
        case "download":
          comparison = a.download_size - b.download_size;
          break;
        case "installed":
          comparison = a.new_size - b.new_size;
          break;
        case "net":
          comparison = (a.new_size - a.current_size) - (b.new_size - b.current_size);
          break;
        default:
          return 0;
      }
      return activeSortDirection === "asc" ? comparison : -comparison;
    });
  }, [filteredUpdates, activeSortKey, activeSortDirection]);

  const { page, perPage, offset, onSetPage, onPerPageSelect, setPage } = usePagination();

  // The full sorted set drives selection, sizing, and sort; only the rendered
  // rows are paginated. Reset to page 1 when the filtered/sorted set changes so
  // a filter never strands the user on a now-empty page.
  useEffect(() => {
    setPage(1);
  }, [searchFilter, repoFilter, securityFilterOn, activeSortKey, activeSortDirection, setPage]);

  const pagedUpdates = useMemo(
    () => sortedUpdates.slice(offset, offset + perPage),
    [sortedUpdates, offset, perPage]
  );

  const heldPackages = useMemo(
    () => updates.filter((u) => u.ignored).map((u) => u.name),
    [updates],
  );
  const deselectedPackages = useMemo(
    () => updates.filter((u) => !u.ignored && !selectedPackages.has(u.name)).map((u) => u.name),
    [updates, selectedPackages],
  );
  const ignoredPackages = useMemo(
    () => [...heldPackages, ...deselectedPackages],
    [heldPackages, deselectedPackages],
  );

  const selectedUpdates = useMemo(() => {
    return updates.filter((u) => selectedPackages.has(u.name));
  }, [updates, selectedPackages]);

  const upgradeNeedsReboot = useMemo(() => {
    return updates.some((u) => selectedPackages.has(u.name) && REBOOT_PACKAGES.has(u.name));
  }, [updates, selectedPackages]);


  const togglePackageSelection = (pkgName: string) => {
    setSelectedPackages((prev) => {
      const next = new Set(prev);
      if (next.has(pkgName)) {
        next.delete(pkgName);
      } else {
        next.add(pkgName);
      }
      return next;
    });
  };

  const selectAllPackages = () => {
    setSelectedPackages(
      new Set(
        updates
          .filter((u) => !u.ignored)
          .map((u) => u.name)
      )
    );
  };

  const deselectAllPackages = () => {
    setSelectedPackages(new Set());
  };

  const visibleSelectable = useMemo(
    () => filteredUpdates.filter((u) => !u.ignored).map((u) => u.name),
    [filteredUpdates],
  );

  const selectOnlyVisible = () => {
    setSelectedPackages(new Set(visibleSelectable));
  };

  const hiddenSelectedCount = useMemo(() => {
    const shown = new Set(filteredUpdates.map((u) => u.name));
    return selectedUpdates.filter((u) => !shown.has(u.name)).length;
  }, [filteredUpdates, selectedUpdates]);

  const selectableCount = updates.length - heldPackages.length;
  const selectableSecurityCount = useMemo(
    () => updates.filter((u) => !u.ignored && actionableSecurityMap.has(u.name)).length,
    [updates, actionableSecurityMap],
  );
  const countKnown = state === "available" || state === "uptodate" || state === "success";
  const checkFailed = (state === "error" && (errorOrigin === "check" || errorOrigin === "sync")) || quietReloadFailed;
  const lastStatusRef = useRef<UpdateStatus>({ count: null, security: 0, failed: false });
  useEffect(() => {
    const status: UpdateStatus = checkFailed
      ? { count: null, security: 0, failed: true }
      : countKnown
        ? { count: selectableCount, security: selectableSecurityCount, failed: false }
        : state === "checking"
          ? { ...lastStatusRef.current, failed: false }
          : { count: null, security: 0, failed: false };
    lastStatusRef.current = status;
    onUpdateStatus?.(status);
  }, [countKnown, checkFailed, selectableCount, selectableSecurityCount, state, onUpdateStatus]);
  const areAllSelected = selectableCount > 0 && deselectedPackages.length === 0;
  const areSomeSelected = selectedPackages.size > 0 && deselectedPackages.length > 0;

  useEffect(() => {
    const el = document.getElementById("select-all-updates") as HTMLInputElement | null;
    if (el) el.indeterminate = areSomeSelected;
  }, [areSomeSelected, areAllSelected]);
  const ignoredCount = heldPackages.length;
  const ignoredNameSet = useMemo(() => new Set(heldPackages), [heldPackages]);

  const loadUpdates = useCallback(async (force = false) => {
    setState("checking");
    setResumeMissNotice(null);
    setError(null);
    setErrorCode(undefined);
    setErrorDetails(undefined);
    setWarnings([]);
    setLockRetryExhausted(false);
    // page_status is published by a dedicated effect (see publishPageStatus
    // effect) so a failed/deferred scheduled run can take precedence.
    try {
      const response = await checkUpdates();
      autoResumedRef.current = false;
      const next = response.updates.length > 0 ? "available" : "uptodate";
      lastGoodRef.current = next;
      setUpdates(response.updates);
      setWarnings(response.warnings);
      databaseTimesRef.current = databaseTimesOf(response);
      setDatabaseTimes(databaseTimesRef.current);
      setLastCheckedAt(Math.floor(Date.now() / 1000));
      setQuietReloadFailed(false);
      setState(next);
      announce(next === "available"
        ? `${plural(response.updates.length, "update", "updates")} available`
        : upToDateTitle(adminAllowedRef.current, databaseTimesRef.current));
      // Callers that pass loadUpdates as a handler may hand it an event.
      if (hasBeenVisibleRef.current) loadSecurityData(force === true);
    } catch (ex) {
      failWith("check", ex instanceof Error ? ex.message : String(ex), ex instanceof BackendError ? ex.code : undefined, ex instanceof BackendError ? ex.details : undefined);
    }
  }, [loadSecurityData, failWith, announce]);

  const readUpdatesQuietly = useCallback(async (announceArrivals: boolean, installedChanged = false): Promise<UpdateInfo[] | null> => {
    let response;
    try {
      response = await checkUpdates();
    } catch {
      setQuietReloadFailed(true);
      return null;
    }
    const next = response.updates.length > 0 ? "available" : "uptodate";
    const versionsChanged = offeredVersions(response.updates) !== offeredVersions(updatesRef.current);
    if (stateRef.current === "available" || stateRef.current === "uptodate") {
      const known = new Set(updatesRef.current.map((u) => u.name));
      const arrived = response.updates.filter((u) => !u.ignored && !known.has(u.name)).map((u) => u.name);
      if (arrived.length > 0) {
        lastArrivalRef.current = Date.now();
        setNewNames((prev) => new Set([...prev, ...arrived]));
        if (announceArrivals) announce(plural(arrived.length, "new update", "new updates"));
      }
    }
    lastGoodRef.current = next;
    setUpdates(response.updates);
    setWarnings(response.warnings);
    databaseTimesRef.current = databaseTimesOf(response);
    setDatabaseTimes(databaseTimesRef.current);
    setLastCheckedAt(Math.floor(Date.now() / 1000));
    setQuietReloadFailed(false);
    setState((s) => (s === "available" || s === "uptodate" ? next : s));
    if ((versionsChanged || installedChanged) && hasBeenVisibleRef.current) void loadSecurityData();
    return response.updates;
  }, [announce, loadSecurityData]);
  const reloadUpdatesQuietly = useCallback((installedChanged = false) => readUpdatesQuietly(true, installedChanged), [readUpdatesQuietly]);

  const failSync = useCallback((err: string, code?: ErrorCode, details?: string) => {
    lastGoodRef.current = null;
    failWith("sync", err, code, details);
  }, [failWith]);

  const scheduledUnacked =
    (latestScheduledRun?.status === "failed" || latestScheduledRun?.status === "skipped" || latestScheduledRun?.status === "unrecorded") &&
    scheduledUndismissed;

  // Single owner of page_status: a failed/deferred scheduled run takes
  // precedence over the update-count, then the normal check states map through.
  useEffect(() => {
    if (scheduledUnacked) {
      const failed = latestScheduledRun?.status === "failed";
      publishPageStatus({
        type: failed ? "error" : "warning",
        title: failed ? "Last scheduled upgrade failed" : "Scheduled upgrade needs attention",
      });
      return;
    }
    switch (state) {
      case "checking":
        publishPageStatus({
          type: null,
          title: "Checking for package updates…",
          details: { pficon: "spinner", link: false },
        });
        break;
      case "uptodate":
        publishPageStatus(databaseTimes.oldestDatabaseAt === null
          ? { type: "warning", title: upToDateTitle(adminAllowed, databaseTimes) }
          : {
            type: null,
            title: upToDateTitle(adminAllowed, databaseTimes),
            details: { pficon: "check", link: false },
          });
        break;
      case "available":
        publishPageStatus({
          type: "info",
          title: `${plural(updates.length, "update")} available`,
          details: { pficon: "enhancement" },
        });
        break;
      case "applying":
        publishPageStatus({
          type: null,
          title: "Upgrading packages…",
          details: { pficon: "spinner", link: false },
        });
        break;
      case "success":
        publishPageStatus(updates.length > 0
          ? {
            type: "info",
            title: `Packages upgraded; ${plural(updates.length, "update")} still available`,
            details: { pficon: "enhancement" },
          }
          : { type: null, title: "Packages upgraded", details: { pficon: "check", link: false } });
        break;
      case "notchecked":
        publishPageStatus({ type: "warning", title: "Could not check for package updates" });
        break;
      case "error":
        publishPageStatus({
          type: "error",
          title: errorOrigin === "upgrade" ? "Package upgrade failed" : "Failed to check for package updates",
        });
        break;
    }
  }, [state, updates.length, scheduledUnacked, latestScheduledRun, errorOrigin, adminAllowed, databaseTimes]);

  useEffect(() => {
    void Promise.resolve().then(() => loadUpdates());
  }, [loadUpdates]);

  const previouslyVisible = useRef(hasBeenVisible);
  useEffect(() => {
    if (hasBeenVisible && !previouslyVisible.current) void Promise.resolve().then(() => loadSecurityData());
    previouslyVisible.current = hasBeenVisible;
  }, [hasBeenVisible, loadSecurityData]);

  const loadRebootStatus = useCallback(async () => {
    try {
      const status = await getRebootStatus();
      setRebootStatus(status);
      return status;
    } catch {
      setRebootStatus(null);
      return null;
    }
  }, []);

  const loadServicesStatus = useCallback(async () => {
    try {
      const status = await getServicesStatus();
      setServicesStatus(status);
      return status;
    } catch {
      setServicesStatus(null);
      return null;
    }
  }, []);

  const loadPacnewStatus = useCallback(async () => {
    try {
      const status = await getPacnewStatus();
      setPacnewStatus(status);
      return status;
    } catch {
      setPacnewStatus(null);
      return null;
    }
  }, []);

  const loadLatestScheduledRun = useCallback(async () => {
    try {
      const { runs, warning } = await getScheduledRuns({ limit: 1 });
      setLatestScheduledRun(runs[0] ?? null);
      setScheduledHistoryWarning(warning ?? null);
    } catch {
      setScheduledHistoryWarning("Scheduled upgrade history is unavailable.");
      setLatestScheduledRun(null);
    }
  }, []);

  useEffect(() => {
    Promise.resolve().then(() => loadLatestScheduledRun());
  }, [loadLatestScheduledRun]);

  useEffect(() => {
    if (!hasBeenVisible) return;
    Promise.resolve().then(() => loadRebootStatus());
    Promise.resolve().then(() => loadServicesStatus());
    Promise.resolve().then(() => loadPacnewStatus());
  }, [hasBeenVisible, loadRebootStatus, loadServicesStatus, loadPacnewStatus]);

  const mountedRef = useRef(true);
  useEffect(() => {
    mountedRef.current = true;
    return () => { mountedRef.current = false; };
  }, []);

  const loadOverview = useCallback(() => {
    return Promise.all([
      listOrphans().catch(() => null),
      getCacheInfo().catch(() => null),
      getKeyringStatus().catch(() => null),
      previewCacheCleanup(DEFAULT_KEEP_VERSIONS).catch(() => null),
    ]).then(([orphans, cache, keyring, projection]) => {
      if (!mountedRef.current) return;
      setOrphanNames(orphans ? orphans.orphans.map((o) => o.name) : null);
      setCacheSize(cache?.total_size ?? null);
      setCacheProjection(projection);
      setKeyringStatus(keyring);
      setSummaryLoading(false);
      return orphans;
    });
  }, []);

  useEffect(() => {
    if (hasBeenVisible) loadOverview();
  }, [hasBeenVisible, loadOverview]);

  const [signoffFailure, setSignoffFailure] = useState<{ rejected: boolean; message: string } | null>(null);
  const [signoffAttempt, setSignoffAttempt] = useState(0);
  useEffect(() => {
    if (!signoffCredentials || !hasBeenVisible || !onToSignOffCount) return;
    let cancelled = false;
    getSignoffList(signoffCredentials)
      .then((res) => {
        if (cancelled) return;
        setSignoffFailure(null);
        onToSignOffCount(countToSignOff(res.signoff_groups, signoffCredentials.username));
      })
      .catch((err) => {
        if (cancelled) return;
        setSignoffFailure({
          rejected: err instanceof BackendError && err.code === "permission_denied",
          message: err instanceof Error ? err.message : String(err),
        });
      });
    return () => {
      cancelled = true;
    };
  }, [signoffCredentials, hasBeenVisible, onToSignOffCount, signoffAttempt]);

  // Track whether we've done initial selection
  const hasInitializedSelection = useRef(false);
  const seenNamesRef = useRef<Set<string>>(new Set());

  // Initialize selected packages when updates load, excluding ignored packages
  // On subsequent loads, preserve user selections
  useEffect(() => {
    const seen = seenNamesRef.current;
    seenNamesRef.current = new Set(updates.filter((u) => !u.ignored).map((u) => u.name));
    if (updates.length === 0) {
      hasInitializedSelection.current = false;
      return;
    }

    const initialized = hasInitializedSelection.current;
    setSelectedPackages((prev) => selectionAfterReload(prev, seen, updates, initialized));
    hasInitializedSelection.current = true;
  }, [updates]);

  useEffect(() => {
    const name = focusKebabRef.current;
    if (!name) return;
    focusKebabRef.current = null;
    const label = `Actions for ${name}`;
    const toggle = [...(tableRef.current?.querySelectorAll<HTMLElement>("button[aria-label]") ?? [])]
      .find((b) => b.getAttribute("aria-label") === label);
    toggle?.focus();
  }, [updates]);

  const reportRebootFailure = (err: unknown) => {
    setRebootError(err instanceof Error ? err.message : String(err));
    announce("Reboot failed", { assertive: true });
    loadRebootStatus();
  };

  const requestReboot = () => {
    setRebootConfirmOpen(false);
    setRebootError(null);
    rebootSystem().catch(reportRebootFailure);
  };

  const restartUnits = (units: string[]) => {
    if (restartingRef.current) return;
    restartingRef.current = true;
    setRestarting(true);
    setRestarted(null);
    restartServices(units)
      .then(() => {
        setRestarted(units);
        announce(restartedText(units));
        loadServicesStatus();
      })
      .catch((err) => {
        pushToast({
          variant: "danger",
          title: `Could not restart ${units.join(", ")}`,
          body: err instanceof Error ? err.message : String(err),
          retry: () => restartUnits(units),
        });
        loadServicesStatus();
      })
      .finally(() => {
        restartingRef.current = false;
        setRestarting(false);
      });
  };

  const handleRefresh = async () => {
    if (cancelRef.current || mutationGate("sync the package databases", adminAllowed, getActiveTransaction()).reason) return;
    reloadNews();
    setState("checking");
    resetLog();
    setLockRetryExhausted(false);
    cancelRef.current = syncDatabase(
      {
        onData: appendLog,
        onComplete: () => { cancelRef.current = null; flushLog(); void loadUpdates(); },
        onError: (message, code, details) => { cancelRef.current = null; flushLog(); failSync(message, code, details); },
      },
      true,
    );
  };

  const handleApplyUpdates = async (options: ApplyOptions = {}) => {
    if (cancelRef.current || mutationGate("apply updates", adminAllowed, getActiveTransaction()).reason) return;
    const request = ++preflightRequest.current;
    const revision = systemRevision.current;
    const list = options.list ?? updates;
    const selection = options.selection ?? selectedPackages;
    const held = list.filter((u) => u.ignored).map((u) => u.name);
    const skipped = list.filter((u) => !u.ignored && !selection.has(u.name)).map((u) => u.name);
    const lateArrival = arrivedRecently(lastArrivalRef.current);
    // Run preflight check first. Leave the error state if we're resuming from a
    // lock error: the confirm modal and preflight indicator only render in the
    // "available" view, so staying in "error" would silently swallow the
    // confirmation prompt and the upgrade would never resume.
    setState("available");
    setResumeMissNotice(null);
    setResuming(false);
    changedDuringPreflightRef.current = false;
    setPreflightLoading(true);
    setError(null);
    setErrorCode(undefined);
    setErrorDetails(undefined);
    setLockRetryExhausted(false);
    try {
      const preflight = await preflightUpgrade([...held, ...skipped]);
      if (request !== preflightRequest.current) return;
      previewRevision.current = revision;
      setPreflightData(preflight);
      setPreflightLoading(false);

      if (!preflight.success) {
        failWith("preflight", preflight.error || "Preflight check failed");
        return;
      }

      const changed = changedDuringPreflightRef.current || revision !== systemRevision.current;
      if (options.confirm || lateArrival || changed || needsUpgradeConfirm(preflight, selection, skipped)) {
        setConfirmOpensStale(changed);
        setConfirmModalOpen(true);
        return;
      }

      startUpgrade(preflight);
    } catch (ex) {
      if (request !== preflightRequest.current) return;
      setPreflightLoading(false);
      failWith("preflight", ex instanceof Error ? ex.message : String(ex), ex instanceof BackendError ? ex.code : undefined, ex instanceof BackendError ? ex.details : undefined);
    }
  };

  const refreshPreview = async () => {
    if (mutationGate("preview updates", adminAllowed, getActiveTransaction()).reason) return;
    const request = ++preflightRequest.current;
    const revision = systemRevision.current;
    const deselected = new Set(
      updatesRef.current.filter((u) => !u.ignored && !selectedRef.current.has(u.name)).map((u) => u.name),
    );
    setPreviewRefreshing(true);
    try {
      const list = (await reloadUpdatesQuietly()) ?? updatesRef.current;
      if (request !== preflightRequest.current) return;
      if (!list.some((u) => !u.ignored)) {
        setConfirmModalOpen(false);
        return;
      }
      const held = list.filter((u) => u.ignored).map((u) => u.name);
      const skipped = list.filter((u) => !u.ignored && deselected.has(u.name)).map((u) => u.name);
      const preflight = await preflightUpgrade([...held, ...skipped]);
      if (request !== preflightRequest.current) return;
      previewRevision.current = revision;
      setConfirmOpensStale(revision !== systemRevision.current);
      if (!preflight.success) {
        setConfirmModalOpen(false);
        failWith("preflight", preflight.error || "Preflight check failed");
        return;
      }
      setPreflightData(preflight);
    } catch (ex) {
      if (request !== preflightRequest.current) return;
      setConfirmModalOpen(false);
      failWith("preflight", ex instanceof Error ? ex.message : String(ex), ex instanceof BackendError ? ex.code : undefined, ex instanceof BackendError ? ex.details : undefined);
    } finally {
      if (request === preflightRequest.current) setPreviewRefreshing(false);
    }
  };

  // The direct path runs before setPreflightData re-renders, so it passes the response in.
  const startUpgrade = (preflight: PreflightResponse | null = preflightData) => {
    if (cancelRef.current || !preflight || mutationGate("apply updates", adminAllowed, getActiveTransaction()).reason) return;
    if (previewRevision.current !== systemRevision.current) {
      setConfirmOpensStale(true);
      setConfirmModalOpen(true);
      return;
    }
    setConfirmModalOpen(false);
    setState("applying");
    resetLog();
    setLockRetryExhausted(false);
    setCancelling(false);
    setCancelOutcome(null);
    setUpgradeProgress(initialProgress);
    setOrphansBefore(orphanNames);
    setPostChecks(null);
    setRestarted(null);
    setUpgradeSummary({
      counts: preflight ? upgradeCounts(preflight) : { upgrade: selectedUpdates.length, install: 0, remove: 0 },
      skipped: deselectedPackages,
      held: heldPackages.length,
    });
    const plan: ProgressPlan = {
      downloadBytes: preflight?.total_download_size ?? 0,
      packages: preflight?.add?.length ?? preflight?.packages_to_upgrade ?? 0,
    };

    const handleEvent = (event: StreamEvent) => {
      setUpgradeProgress((prev) => reduceProgress(prev, event, plan));
    };

    cancelRef.current = runUpgrade({
      onEvent: handleEvent,
      onData: appendLog,
      onComplete: () => {
        flushLog();
        autoResumedRef.current = false;
        if (isCancellingRef.current) {
          setCancelling(false);
          setCancelOutcome({ kind: "finished" });
        }
        setState("success");
        setUpdates([]);
        cancelRef.current = null;
        announce("Upgrade finished");
        if (optInRef.current.reboot) {
          requestReboot();
          return;
        }
        reloadUpdatesQuietly(true);
        postRunRef.current += 1;
        const run = postRunRef.current;
        setPostChecks({ reboot: "pending", services: "pending", pacnew: "pending", orphans: "pending" });
        const settle = (check: PostRunCheck) => (result: unknown) => {
          if (postRunRef.current !== run) return;
          setPostChecks((prev) => prev && { ...prev, [check]: result === null ? "failed" : "done" });
        };
        loadRebootStatus().then(settle("reboot"));
        loadPacnewStatus().then(settle("pacnew"));
        loadOverview().then(settle("orphans"));
        loadServicesStatus().then((status) => {
          settle("services")(status);
          if (optInRef.current.restart && status?.restart_required) {
            const units = status.services
              .filter((s) => !effectiveBlock(s, isLocalCockpit))
              .map((s) => s.name);
            if (units.length > 0) restartUnits(units);
          }
        });
      },
      onError: (err, code, details) => {
        flushLog();
        cancelRef.current = null;
        const cancellationRequested = isCancellingRef.current;
        setCancelling(false);
        if (cancellationRequested && code === "cancelled") {
          setCancelOutcome({ kind: "stopped", detail: err });
          announce("Upgrade cancelled");
          loadUpdates();
          loadRebootStatus();
          loadPacnewStatus();
          return;
        }
        announce("Upgrade failed", { assertive: true });
        failWith("upgrade", err, code, details);
      },
    }, ignoredPackages, removalNames(preflight));
  };

  const resumeUpgrade = async () => {
    const list = await reloadUpdatesQuietly();
    if (list && list.every((u) => u.ignored)) {
      setState(list.length > 0 ? "available" : "uptodate");
      if (list.length === 0) announce(upToDateTitle(adminAllowedRef.current, databaseTimesRef.current));
      return;
    }
    resumeRef.current.apply({
      confirm: true,
      ...(list && {
        list,
        selection: selectionAfterReload(selectedRef.current, seenNamesRef.current, list, hasInitializedSelection.current),
      }),
    });
  };

  const resumeSelection = async (names: string[], missText = "None of the updates from that upgrade are pending any more") => {
    setResuming(true);
    setResumeMissNotice(null);
    const list = (await reloadUpdatesQuietly()) ?? updatesRef.current;
    const selection = selectionAfterReload(new Set(names), seenNamesRef.current, list, hasInitializedSelection.current);
    if (selection.size === 0) {
      const text = missText;
      setResuming(false);
      setResumeMissNotice(text);
      announce(text);
      return;
    }
    setSelectedPackages(selection);
    resumeRef.current.apply({ confirm: true, list, selection });
  };

  const resumeRef = useRef({ apply: handleApplyUpdates, refresh: handleRefresh, upgrade: resumeUpgrade, selection: resumeSelection });
  useEffect(() => {
    resumeRef.current = { apply: handleApplyUpdates, refresh: handleRefresh, upgrade: resumeUpgrade, selection: resumeSelection };
  });

  const confirmNavigation = useMemo(() => ({
    ...navigation,
    onViewCache: navigation.onViewCache && ((context?: CacheContext) => {
      if (!context) {
        navigation.onViewCache?.();
        return;
      }
      const selection = [...selectedRef.current];
      navigation.onViewCache?.({ ...context, selection, resume: () => resumeRef.current.selection(selection) });
    }),
  }), [navigation]);

  // Resume the operation that hit the lock. Upgrades go back through the list
  // and preflight since the lock holder may have changed package state. Origin
  // is passed in (not read from state) so a stale recovery flow resumes its own episode.
  const resumeAfterLock = useCallback((origin: ErrorOrigin) => {
    if (origin === "preflight" || origin === "upgrade") {
      resumeRef.current.upgrade();
    } else if (origin === "sync") {
      resumeRef.current.refresh();
    } else {
      loadUpdates();
    }
  }, [loadUpdates]);

  const manualResumeAfterLock = useCallback(() => {
    autoResumedRef.current = false;
    resumeAfterLock(errorOrigin);
  }, [resumeAfterLock, errorOrigin]);

  const selectionCount = selectedPackages.size;
  const openKeyringForRetry = useCallback(() => {
    onViewKeyring?.({ origin: "upgrade", count: selectionCount, retry: () => resumeAfterLock("upgrade") });
  }, [onViewKeyring, resumeAfterLock, selectionCount]);

  // The lock-error heuristic also matches transaction failures that are not
  // lock related, so the no-lock-found auto retry gets one attempt before
  // falling back to the plain error display.
  const autoResumeAfterLock = useCallback(() => {
    if (autoResumedRef.current) {
      setLockRetryExhausted(true);
      return;
    }
    autoResumedRef.current = true;
    resumeAfterLock(errorOrigin);
  }, [resumeAfterLock, errorOrigin]);

  const retryOrigin = (networkFailure: boolean): ErrorOrigin => {
    if (errorOrigin === "sync" && adminAllowed === false) return "check";
    if (errorOrigin === "check" && networkFailure && adminAllowed !== false) return "sync";
    return errorOrigin;
  };

  const retryFailed = (networkFailure = false) => {
    autoResumedRef.current = false;
    switch (retryOrigin(networkFailure)) {
      case "sync":
        handleRefresh();
        break;
      case "check":
        loadUpdates(true);
        break;
      default:
        handleApplyUpdates();
    }
  };

  // A failed upgrade may have changed the system, so its list is re-read
  // rather than restored.
  const dismissError = () => {
    if (errorOrigin === "upgrade") {
      loadUpdates();
      return;
    }
    setState(lastGoodRef.current ?? "notchecked");
  };

  const checkForUpdates = () => {
    autoResumedRef.current = false;
    if (adminAllowed === false) {
      loadUpdates();
    } else {
      handleRefresh();
    }
  };

  const reloadAndRefocus = async (name: string) => {
    focusKebabRef.current = name;
    if ((await reloadUpdatesQuietly()) === null) focusKebabRef.current = null;
  };

  const changeIgnored = async (name: string, ignore: boolean) => {
    try {
      await (ignore ? addIgnoredPackage(name) : removeIgnoredPackage(name));
    } catch (err) {
      pushToast({
        variant: "danger",
        title: ignore ? `Could not ignore ${name}` : `Could not stop ignoring ${name}`,
        body: err instanceof Error ? err.message : String(err),
      });
      return false;
    }
    return true;
  };

  const handleIgnoreChange = async (name: string, ignore: boolean) => {
    if (!(await changeIgnored(name, ignore))) return;
    pushToast({
      variant: "success",
      title: ignoreNotice(name, ignore),
      undo: async () => {
        await changeIgnored(name, !ignore);
        await reloadUpdatesQuietly();
      },
    });
    await reloadAndRefocus(name);
  };

  const refreshQuietly = (kind?: SystemChangeKind) => {
    const current = stateRef.current;
    if (current === "loading" || current === "checking" || current === "applying") return;
    if (confirmModalOpen || rebootConfirmOpen || preflightLoading) {
      queuedRefreshRef.current = true;
      if (preflightLoading) changedDuringPreflightRef.current = true;
      return;
    }
    reloadUpdatesQuietly(kind !== "sync");
    void refreshDetails();
    loadRebootStatus();
    loadServicesStatus();
    loadPacnewStatus();
    loadOverview();
    loadLatestScheduledRun();
  };
  useRefreshOnActivate(refreshQuietly, { kinds: ["system", "sync"] });

  const tabActive = useTabActive();
  const refreshListWhileHidden = (kind: SystemChangeKind) => {
    if (tabActive) return;
    const current = stateRef.current;
    if (current !== "available" && current !== "uptodate" && current !== "success") return;
    if (confirmModalOpen || rebootConfirmOpen || preflightLoading || resuming) return;
    void readUpdatesQuietly(false, kind === "system");
  };
  const refreshListWhileHiddenRef = useRef(refreshListWhileHidden);
  useEffect(() => {
    refreshListWhileHiddenRef.current = refreshListWhileHidden;
  });
  useEffect(() => onSystemChanged((kind) => refreshListWhileHiddenRef.current(kind), ["system", "sync"]), []);
  const refreshQuietlyRef = useRef(refreshQuietly);
  useEffect(() => {
    refreshQuietlyRef.current = refreshQuietly;
  });
  useEffect(() => {
    if (confirmModalOpen || rebootConfirmOpen || preflightLoading || !queuedRefreshRef.current) return;
    queuedRefreshRef.current = false;
    refreshQuietlyRef.current();
  }, [confirmModalOpen, rebootConfirmOpen, preflightLoading]);

  const scheduleGate = mutationGate("manage the upgrade schedule", adminAllowed, null);

  const openScheduleHistory = () => {
    setScheduleHistoryOnOpen(true);
    setScheduleModalOpen(true);
  };

  const closeScheduleModal = () => {
    setScheduleModalOpen(false);
    setScheduleHistoryOnOpen(false);
  };

  const handleScheduleSaved = (message: string) => {
    pushToast({ variant: "success", title: "Schedule saved", body: message });
    loadLatestScheduledRun();
  };

  const handleCancelClick = () => {
    setCancelModalOpen(true);
  };

  const confirmCancel = () => {
    if (isCancellingRef.current) return;
    setCancelModalOpen(false);
    if (cancelRef.current) {
      setCancelling(true);
      cancelRef.current.cancel();
    }
  };

  useEffect(() => {
    if (detailsTarget) {
      fetchDetails(detailsTarget.name, detailsTarget.repo ? { strategy: "sync", repo: detailsTarget.repo } : { strategy: "local" });
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
      const target = detailsTarget ? `${detailsTarget.name}|${detailsTarget.repo ?? ""}` : "|";
      if (`${options.pkg}|${options.repo}` !== target) {
        setDetailsTarget(options.pkg ? { name: options.pkg, repo: options.repo || undefined } : null);
      }
    },
  );

  const handlePackageClick = (pkgName: string) => {
    setDetailsTarget((current) => (current?.name === pkgName && !current.repo ? current : { name: pkgName }));
  };

  const closeDetails = () => setDetailsTarget(null);

  const dismissNotice = (title: string, dismiss: () => () => void) => {
    const undo = dismiss();
    pushToast({ variant: "info", title: `${title} dismissed`, undo });
  };

  const handleDismissNews = (item: { link: string; title: string }) => {
    const { undo } = dismissNewsItem(item.link);
    pushToast({ variant: "info", title: `News item dismissed: ${item.title}`, undo });
  };

  const handleDismissAllNews = () => {
    const { links, undo } = dismissAllNews();
    pushToast({
      variant: "info",
      title: `${links.length} news items dismissed`,
      undo,
    });
  };

  const newsAlertList = visibleNews.map((item) => (
    <Alert
      key={item.link}
      variant="info"
      title={item.title}
      actionClose={<AlertActionCloseButton onClose={() => handleDismissNews(item)} />}
      className="pf-v6-u-mb-md"
    >
      <Content component={ContentVariants.p}>{item.summary}</Content>
      <div className="pf-v6-u-font-size-sm pf-v6-u-color-200 pf-v6-u-mt-sm">
        <small><TimeAgo timestamp={item.published} dateOnly /></small>
        {" -- "}
        <a href={sanitizeUrl(item.link) ?? "#"} target="_blank" rel="noopener noreferrer">Read more on archlinux.org</a>
      </div>
    </Alert>
  ));

  const newsAlerts = (
    <>
      {visibleNews.length >= 2 && (
        <Flex justifyContent={{ default: "justifyContentFlexEnd" }} className="pf-v6-u-mb-sm">
          <FlexItem>
            <Button variant="link" isInline onClick={handleDismissAllNews}>
              Dismiss all ({visibleNews.length})
            </Button>
          </FlexItem>
        </Flex>
      )}
      {newsAlertList}
    </>
  );

  const newsErrorAlert = newsError ? (
    <Alert
      variant="warning"
      title="Unable to fetch Arch Linux news"
      actionClose={<AlertActionCloseButton onClose={clearNewsError} />}
      actionLinks={<AlertActionLink onClick={reloadNews}>Try again</AlertActionLink>}
      className="pf-v6-u-mb-md"
    >
      Could not retrieve the latest news from archlinux.org. Check the host&apos;s network connection or visit the{" "}
      <a href={ARCH_STATUS_URL} target="_blank" rel="noopener noreferrer">Arch Linux status page</a>
      {" "}for service updates.
    </Alert>
  ) : newsStale ? (
    <Alert
      variant="info"
      isInline
      title="Showing cached news"
      className="pf-v6-u-mb-md"
    >
      Couldn&apos;t reach archlinux.org. The news below is from the last successful fetch.
    </Alert>
  ) : null;

  const securityStaleAlert = securityStale ? (
    <Alert
      variant="warning"
      isInline
      title="Showing cached security advisories"
      className="pf-v6-u-mb-md"
    >
      Couldn&apos;t reach the Arch security tracker. Advisories below are from the last successful
      fetch and may not reflect recently disclosed or fixed issues.
    </Alert>
  ) : securityUnavailable ? (
    <Alert
      variant="warning"
      isInline
      title="Security status unavailable"
      className="pf-v6-u-mb-md"
    >
      Couldn&apos;t reach the Arch security tracker and no cached data is available, so known
      vulnerabilities can&apos;t be checked. This is not a clean bill of health.
    </Alert>
  ) : null;

  const rebootAlert = rebootStatus?.requires_reboot && rebootUndismissed ? (
    <Alert
      variant="warning"
      title={NOTICE_TITLE.reboot}
      className="pf-v6-u-mb-md"
      actionClose={
        <AlertActionCloseButton
          onClose={() => dismissNotice("Reboot notice", rebootNotice.dismiss)}
        />
      }
      actionLinks={
        <GatedButton
          gate={rebootMutation}
          variant="link"
          isInline
          icon={<PowerOffIcon />}
          onClick={() => setRebootConfirmOpen(true)}
        >
          Reboot now
        </GatedButton>
      }
    >
      {rebootStatus.reason === "kernel_update" ? (
        <>
          Running kernel ({rebootStatus.running_kernel}) differs from installed kernel ({rebootStatus.installed_kernel}).
          Reboot to use the new kernel.
        </>
      ) : (
        <>
          Critical system packages were updated since boot: {rebootStatus.updated_packages.join(", ")}.
          A reboot is recommended to apply these changes.
        </>
      )}
    </Alert>
  ) : null;

  const rebootErrorAlert = rebootError ? (
    <Alert
      variant="danger"
      isInline
      title="Could not reboot the system"
      className="pf-v6-u-mb-md"
      actionClose={<AlertActionCloseButton onClose={() => setRebootError(null)} />}
    >
      {rebootError}
    </Alert>
  ) : null;

  const rebootConfirmModal = (
    <ConfirmModal
      isOpen={rebootConfirmOpen}
      title="Reboot the system?"
      severity="danger"
      commitLabel="Reboot now"
      onConfirm={requestReboot}
      onClose={() => setRebootConfirmOpen(false)}
    >
      {rebootReason(rebootStatus) && `${rebootReason(rebootStatus)} `}
      All sessions, including this Cockpit page, end. Unsaved work in other applications is lost.
    </ConfirmModal>
  );

  const cancelAlert = cancelOutcome ? (
    <Alert
      variant={cancelOutcome.kind === "stopped" ? "warning" : "success"}
      title={cancelOutcome.kind === "stopped"
        ? "Upgrade cancelled"
        : "Upgrade finished before the cancel took effect"}
      className="pf-v6-u-mb-md"
      actionClose={<AlertActionCloseButton onClose={() => setCancelOutcome(null)} />}
    >
      {cancelOutcome.kind === "stopped" && (
        <>
          {cancelOutcome.detail}
          {" The update list has been rechecked; what it shows now is what is still pending."}
        </>
      )}
    </Alert>
  ) : null;

  const pacnewAlert = pacnewNeedsReview(pacnewStatus) && pacnewUndismissed ? (
    <Alert
      variant="warning"
      title={pacnewTitle(pacnewStatus)}
      className="pf-v6-u-mb-md"
      actionClose={
        <AlertActionCloseButton
          onClose={() => dismissNotice("Configuration merge notice", pacnewNotice.dismiss)}
        />
      }
    >
      <Content component={ContentVariants.p}>{pacnewSummary(pacnewStatus)}</Content>
      <PacnewFileList files={pacnewStatus.files} />
      <GatedButton gate={reconciliationMutation} variant="link" isInline onClick={() => setReconciliationOpen(true)}>Review configuration files</GatedButton>
    </Alert>
  ) : null;

  const resumeMissAlert = resumeMissNotice ? (
    <Alert
      variant="info"
      isInline
      title={resumeMissNotice}
      className="pf-v6-u-mb-md"
      actionClose={<AlertActionCloseButton onClose={() => setResumeMissNotice(null)} />}
    />
  ) : null;

  const lockClearedAlert = lockCleared ? (
    <Alert
      variant="info"
      isInline
      title="Cleared a leftover database lock"
      className="pf-v6-u-mb-md"
      actionClose={<AlertActionCloseButton onClose={() => setLockCleared(false)} />}
    >
      A package transaction was interrupted before it could finish. If an earlier upgrade looks
      incomplete, check the package list.
    </Alert>
  ) : null;

  const scheduledAlert = scheduledUnacked && latestScheduledRun ? (
    <Alert
      variant={latestScheduledRun.status === "failed" ? "danger" : "warning"}
      title={
        latestScheduledRun.status === "failed"
          ? "Last scheduled upgrade failed"
          : latestScheduledRun.status === "unrecorded" ? "Scheduled upgrade outcome was not recorded" : "Scheduled upgrade was deferred"
      }
      className="pf-v6-u-mb-md"
      actionClose={
        <AlertActionCloseButton
          onClose={() => dismissNotice("Scheduled upgrade notice", scheduledNotice.dismiss)}
        />
      }
    >
      <Content component={ContentVariants.p}>
        {latestScheduledRun.error
          ? latestScheduledRun.error
          : latestScheduledRun.details.join("; ") || "No further detail recorded."}
      </Content>
      <Content component={ContentVariants.small}>
        <Button variant="link" isInline onClick={openScheduleHistory}>View run history</Button>
        {", or run "}
        <code>journalctl -u cockpit-pacman-scheduled</code> for the full log.
      </Content>
    </Alert>
  ) : null;

  const lastRunStatus = latestScheduledRun ? scheduledRunSummary(latestScheduledRun) : "";
  const LastRunIcon = lastRunStatus === "failed"
    ? ExclamationCircleIcon
    : (lastRunStatus.startsWith("skipped") || lastRunStatus === "outcome was not recorded") ? ExclamationTriangleIcon : CheckCircleIcon;
  const lastRunToken = lastRunStatus === "failed"
    ? "danger"
    : (lastRunStatus.startsWith("skipped") || lastRunStatus === "outcome was not recorded") ? "warning" : "success";
  const scheduledRunLine = latestScheduledRun && !scheduledAlert ? (
    <Flex
      spaceItems={{ default: "spaceItemsSm" }}
      alignItems={{ default: "alignItemsCenter" }}
      className="pf-v6-u-mb-md pf-v6-u-font-size-sm"
    >
      <FlexItem>
        <LastRunIcon color={`var(--pf-t--global--icon--color--status--${lastRunToken}--default)`} />
      </FlexItem>
      <FlexItem>Last scheduled run: {lastRunStatus}</FlexItem>
      <FlexItem className="pf-v6-u-color-200"><TimeAgo timestamp={latestScheduledRun.timestamp} /></FlexItem>
      <FlexItem>
        <Button variant="link" isInline onClick={openScheduleHistory}>View run history</Button>
      </FlexItem>
    </Flex>
  ) : null;

  const [isLocalCockpit] = useState(() =>
    ["localhost", "127.0.0.1", "::1", ""].includes(window.location.hostname),
  );
  const safeServices = servicesStatus?.services.filter((s) => !effectiveBlock(s, isLocalCockpit)) ?? [];
  const blockedServices = servicesStatus?.services.filter((s) => effectiveBlock(s, isLocalCockpit)) ?? [];
  const servicesPartialAlert = servicesStatus?.scan_incomplete ? (
    <Alert
      variant="info"
      isInline
      title="Service check was incomplete"
      className="pf-v6-u-mb-md"
    >
      Some running processes could not be inspected, so services needing a
      restart may be missing from this list. Turn on administrative access for a
      complete answer.
    </Alert>
  ) : null;

  const servicesAlert = servicesStatus?.restart_required && servicesUndismissed ? (
    <Alert
      variant="warning"
      title={NOTICE_TITLE.services}
      className="pf-v6-u-mb-md"
      actionClose={
        <AlertActionCloseButton
          onClose={() => dismissNotice("Service restart notice", servicesNotice.dismiss)}
        />
      }
      actionLinks={
        safeServices.length > 0 ? (
          <GatedButton
            gate={restartMutation}
            variant="link"
            isInline
            isLoading={restarting}
            onClick={() => restartUnits(safeServices.map((s) => s.name))}
          >
            {restartLabel(safeServices.length)}
          </GatedButton>
        ) : undefined
      }
    >
      {safeServices.length > 0 && (
        <>
          <div className="pf-v6-u-mb-sm">Safe to restart from Cockpit:</div>
          <List>
            {safeServices.map((svc) => (
              <ListItem key={svc.name}>
                <strong>{svc.name}</strong>
                {svc.affected_packages.length > 0 && ` (${svc.affected_packages.join(", ")})`}
              </ListItem>
            ))}
          </List>
        </>
      )}
      {blockedServices.length > 0 && (
        <>
          <div className="pf-v6-u-mt-md">Cockpit can&apos;t restart these safely:</div>
          <List>
            {blockedServices.map((svc) => {
              const blk = effectiveBlock(svc, isLocalCockpit);
              const note =
                blk === "session_critical"
                  ? "Restarting this would log out the desktop session."
                  : "Restarting this would disconnect your Cockpit session.";
              return (
                <ListItem key={svc.name} className="pf-v6-u-color-200">
                  <strong>{svc.name}</strong>
                  {svc.affected_packages.length > 0 && ` (${svc.affected_packages.join(", ")})`}
                  <div className="pf-v6-u-font-size-sm">{note}</div>
                </ListItem>
              );
            })}
          </List>
        </>
      )}
    </Alert>
  ) : null;

  const coveredByStep = (key: string) =>
    state === "success" && (key === "reboot" || key === "services" || key === "pacnew") && postChecks?.[key] === "done";
  const dismissedEntries: { key: string; label: string; showAgain: () => void }[] = [
    ...(rebootStatus?.requires_reboot && rebootNotice.dismissed
      ? [{ key: "reboot", label: NOTICE_TITLE.reboot, showAgain: rebootNotice.restore }]
      : []),
    ...(servicesStatus?.restart_required && servicesNotice.dismissed
      ? [{ key: "services", label: NOTICE_TITLE.services, showAgain: servicesNotice.restore }]
      : []),
    ...(pacnewNeedsReview(pacnewStatus) && pacnewNotice.dismissed
      ? [{ key: "pacnew", label: pacnewTitle(pacnewStatus), showAgain: pacnewNotice.restore }]
      : []),
    ...((latestScheduledRun?.status === "failed" || latestScheduledRun?.status === "skipped" || latestScheduledRun?.status === "unrecorded") && scheduledNotice.dismissed
      ? [{
        key: "scheduled",
        label: latestScheduledRun.status === "failed" ? "Last scheduled upgrade failed" : latestScheduledRun.status === "unrecorded" ? "Scheduled upgrade outcome was not recorded" : "Scheduled upgrade was deferred",
        showAgain: scheduledNotice.restore,
      }]
      : []),
    ...dismissedNews.map((item) => ({
      key: item.link,
      label: item.title,
      showAgain: () => restoreNewsItem(item.link),
    })),
  ];
  const dismissedNotices = dismissedEntries.filter((n) => !coveredByStep(n.key));

  const dismissedNoticesSection = dismissedNotices.length > 0 ? (
    <div className="pf-v6-u-mb-md">
      <Button
        variant="link"
        isInline
        aria-expanded={showDismissed}
        aria-controls="updates-dismissed-notices"
        onClick={() => setShowDismissed((v) => !v)}
      >
        {plural(dismissedNotices.length, "dismissed notice")}
      </Button>
      {showDismissed && (
        <List id="updates-dismissed-notices" isPlain className="pf-v6-u-mt-sm">
          {dismissedNotices.map((n) => (
            <ListItem key={n.key}>
              <Flex spaceItems={{ default: "spaceItemsSm" }} alignItems={{ default: "alignItemsCenter" }}>
                <FlexItem>{n.label}</FlexItem>
                <FlexItem><Label isCompact color="grey">Dismissed</Label></FlexItem>
                <FlexItem>
                  <Button variant="link" isInline onClick={n.showAgain} aria-label={`Show again: ${n.label}`}>
                    Show again
                  </Button>
                </FlexItem>
              </Flex>
            </ListItem>
          ))}
        </List>
      )}
    </div>
  ) : null;

  const toastGroup = (
    <AlertGroup isToast isLiveRegion>
      {toasts.map((t) => (
        <Alert
          key={t.id}
          variant={t.variant}
          title={t.title}
          timeout={t.variant === "danger" || t.retry ? false : 8000}
          onTimeout={() => closeToast(t.id)}
          actionClose={<AlertActionCloseButton onClose={() => closeToast(t.id)} />}
          actionLinks={t.undo ? (
            <AlertActionLink onClick={() => { closeToast(t.id); t.undo?.(); }}>Undo</AlertActionLink>
          ) : t.retry ? (
            <AlertActionLink onClick={() => { closeToast(t.id); t.retry?.(); }}>Try again</AlertActionLink>
          ) : undefined}
        >
          {t.body}
        </Alert>
      ))}
    </AlertGroup>
  );

  const keyringUninitializedAlert = keyringStatus?.status === "uninitialized" ? (
    <Alert
      variant="warning"
      title="Keyring not initialized"
      isInline
      className="pf-v6-u-mb-md"
      actionLinks={onViewKeyring ? <AlertActionLink onClick={() => onViewKeyring()}>Open Keyring</AlertActionLink> : undefined}
    >
      The pacman keyring is not initialized. Package signature verification may fail.
    </Alert>
  ) : null;

  const unprivilegedAlert = adminAllowed === false ? (
    <Alert
      variant="info"
      isInline
      title={databaseTimes.oldestDatabaseAt === null
        ? "Showing updates from the last database sync"
        : databaseAge(databaseTimes, "Showing updates as of the last check", "Showing updates in package databases from")}
      className="pf-v6-u-mb-md"
    >
      Turn on administrative access to check for new updates. Use the Limited
      access button in Cockpit&apos;s top bar.
    </Alert>
  ) : null;

  const databaseAgeItem = (
    <ToolbarItem alignSelf="center">
      <Content component={ContentVariants.small}>
        {databaseTimes.oldestDatabaseAt === null ? (
          <>
            <ExclamationTriangleIcon color="var(--pf-t--global--icon--color--status--warning--default)" />
            {" Some package databases have never been synced"}
          </>
        ) : databaseAge(databaseTimes, "Checked for updates", "Package databases from")}
      </Content>
    </ToolbarItem>
  );

  const noticeCount = [rebootAlert, servicesAlert, pacnewAlert].filter(Boolean).length;
  const notices = (
    <>
      {rebootAlert}
      {servicesPartialAlert}
      {servicesAlert}
      {pacnewAlert}
    </>
  );

  const signoffFailureAlert = signoffCredentials && signoffFailure && toSignOff === null ? (
    <Alert
      variant="warning"
      isInline
      className="pf-v6-u-mb-md"
      title={signoffFailure.rejected ? "ArchWeb rejected the stored credentials" : "Could not count packages to sign off"}
      actionLinks={
        <>
          <AlertActionLink onClick={() => setSignoffAttempt((n) => n + 1)}>Try again</AlertActionLink>
          {onViewSignoffs && <AlertActionLink onClick={() => onViewSignoffs()}>Open Signoffs</AlertActionLink>}
        </>
      }
    >
      {signoffFailure.rejected
        ? "The username or password in the ArchWeb keyring item was not accepted, so signoffs cannot be counted. Store the current password, then try again."
        : signoffFailure.message}
    </Alert>
  ) : null;

  const pageAlerts = (
    <>
      {toastGroup}
      {unprivilegedAlert}
      {signoffFailureAlert}
      {cancelAlert}
      {lockClearedAlert}
      {resumeMissAlert}
      {rebootErrorAlert}
      {state === "success" ? null : noticeCount >= 2 ? (
        <ExpandableSection
          toggleText={`${noticeCount} notices`}
          isExpanded={noticesExpanded}
          onToggle={(_event, expanded) => setNoticesExpanded(expanded)}
          className="pf-v6-u-mb-md"
        >
          {notices}
        </ExpandableSection>
      ) : notices}
      {scheduledHistoryWarning && <Alert variant="warning" isInline title="Scheduled upgrade history is incomplete">{scheduledHistoryWarning}</Alert>}
      {scheduledAlert}
      {scheduledRunLine}
      {dismissedNoticesSection}
      <ScheduleModal
        isOpen={scheduleModalOpen}
        onClose={closeScheduleModal}
        onSaved={handleScheduleSaved}
        initialHistoryExpanded={scheduleHistoryOnOpen}
      />
      {rebootConfirmModal}
      {reconciliationOpen && <ConfigReconciliationModal files={pacnewStatus?.files ?? []} onClose={() => setReconciliationOpen(false)} onScanned={setPacnewStatus} />}
    </>
  );

  const ignoredModal = (
    <IgnoredPackagesModal
      isOpen={ignoredModalOpen}
      onClose={() => setIgnoredModalOpen(false)}
      onIgnoredChange={() => reloadUpdatesQuietly()}
      initialFilter={ignoredModalFocus}
      focusName={ignoredModalFocus}
      key="ignored-modal"
    />
  );

  const withDetails = (content: React.ReactNode) => (
    <PackageDetailsDrawer
      activeKey={detailsName}
      packageDetails={selectedPackage}
      isLoading={packageLoading}
      onClose={closeDetails}
      error={detailsError}
      errorCode={detailsErrorCode}
      errorDetails={detailsErrorContext}
      isRemoved={detailsRemoved}
      onViewDependencies={onViewDependencies}
      onViewHistory={onViewHistory}
      onPackageRemoved={loadUpdates}
      isIgnored={selectedPackage ? ignoredNameSet.has(selectedPackage.name) : false}
      onIgnored={reloadUpdatesQuietly}
    >
      {content}
    </PackageDetailsDrawer>
  );

  const allHeld = updates.length > 0 && heldPackages.length === updates.length;
  const lastCheckedLine = quietReloadFailed && lastCheckedAt !== null ? (
    <>
      {" · "}
      <ExclamationTriangleIcon color="var(--pf-t--global--icon--color--status--warning--default)" />
      {" Could not reload the list. Last loaded "}
      <TimeAgo timestamp={lastCheckedAt} />
    </>
  ) : null;
  const cardTotals = selectionTotals(selectedUpdates);
  const manageIgnoredLink = (
    <GatedButton gate={ignoredMutation} variant="link" isInline onClick={() => openIgnoredModal()}>
      Manage ignored packages
    </GatedButton>
  );
  const applyButton = (
    <GatedButton
      ref={applyButtonRef}
      gate={applyMutation}
      disabledReason={
        preflightLoading || resuming ? "Checking the upgrade…" : selectedPackages.size === 0 && "Select at least one update"
      }
      variant="primary"
      onClick={() => {
        autoResumedRef.current = false;
        handleApplyUpdates();
      }}
      isLoading={preflightLoading || resuming}
    >
      {preflightLoading || resuming
        ? "Checking…"
        : `Apply ${plural(selectedPackages.size, "update", "updates")}${hiddenSelectedCount > 0 ? ` (${hiddenSelectedCount.toLocaleString()} not shown)` : ""}`}
    </GatedButton>
  );
  // Null outside the list view keeps the children after it at the same index,
  // so a quiet reload between "uptodate" and "available" does not remount them.
  const skipLink = state === "available" && !allHeld ? (
    <SkipToContent
      href="#updates-list-header"
      onClick={(e: React.MouseEvent) => {
        e.preventDefault();
        listHeaderRef.current?.focus();
      }}
    >
      Skip to updates
    </SkipToContent>
  ) : null;

  if (state === "loading" || state === "checking") {
    return withDetails(
      <Card>
        <CardBody>
          {toastGroup}
          <EmptyState  headingLevel="h2" icon={Spinner}  titleText="Checking for updates">
            <EmptyStateBody>
              Querying package databases…
            </EmptyStateBody>
          </EmptyState>
        </CardBody>
      </Card>
    );
  }

  if (state === "error") {
    // The tx-init pattern deliberately over-matches beyond isDbLockError;
    // the bounded auto-retry in autoResumeAfterLock absorbs false positives.
    const isLockError = isDbLockError(error ?? "", errorCode)
      || (error ? /failed to initialize transaction/i.test(error) : false);
    const showLockRecovery = isLockError && !lockRetryExhausted;
    // Only a genuine connectivity failure shows the offline state here. This
    // heuristic is intentionally stricter than parseErrorCode: a bare operation
    // timeout, or the unqualified word "network", is not an unreachable-host
    // condition, so it keeps its specific message rather than the offline page.
    const networkError = !isLockError && (
      errorCode === "network_error" ||
      (!errorCode && error ? /failed to retrieve|unable to connect|could not resolve|dns|connection refused/i.test(error) : false)
    );
    const signatureFailure = !isLockError && (errorCode ?? parseErrorCode(error ?? "")) === "signature_error"
      && (errorOrigin === "preflight" || errorOrigin === "upgrade");
    const showOpenKeyring = signatureFailure && !!onViewKeyring;
    return withDetails(
      <Card>
        <CardBody>
          {toastGroup}
          {networkError ? (
            <NetworkErrorState
              resource="updates"
              onRetry={() => retryFailed(true)}
              retryLabel={RETRY_LABELS[retryOrigin(true)]}
              onDismiss={dismissError}
            />
          ) : (
            <EmptyState
              headingLevel="h2"
              icon={ExclamationCircleIcon}
              titleText={showLockRecovery
                ? "Database is locked"
                : signatureFailure ? "Package signature could not be verified" : ERROR_TITLES[errorOrigin]}
              status={showLockRecovery ? "warning" : "danger"}
            >
              <EmptyStateBody>
                {showLockRecovery
                  ? <LockErrorBody key={errorEpoch} onRetry={manualResumeAfterLock} onAutoRetry={autoResumeAfterLock} onReleased={manualResumeAfterLock} onCleared={() => setLockCleared(true)} retryLabel="Resume" onStateChange={setLockWaitState} />
                  : error}
                {signatureFailure && <Content component={ContentVariants.p} className="pf-v6-u-mt-sm">{SIGNATURE_HELP}</Content>}
                <ErrorDetails details={errorDetails} />
              </EmptyStateBody>
              <EmptyStateFooter>
                <EmptyStateActions>
                  {showOpenKeyring && (
                    <Button variant="primary" onClick={openKeyringForRetry}>Open Keyring</Button>
                  )}
                  {!(showLockRecovery && HOST_RETRY_HIDDEN.has(lockWaitState)) && (
                    <Button
                      variant={showOpenKeyring ? "secondary" : "primary"}
                      onClick={showLockRecovery ? manualResumeAfterLock : () => retryFailed()}
                    >
                      {showLockRecovery ? "Resume" : RETRY_LABELS[retryOrigin(false)]}
                    </Button>
                  )}
                  <Button variant="link" onClick={dismissError}>Dismiss</Button>
                </EmptyStateActions>
              </EmptyStateFooter>
            </EmptyState>
          )}
          {(errorOrigin === "upgrade" || errorOrigin === "sync") && log && (
            <LogViewer log={log} className="pf-v6-u-mt-md" />
          )}
        </CardBody>
      </Card>
    );
  }

  if (state === "applying") {
    const progressValue = progressPercent(upgradeProgress);
    const modifying = upgradeProgress.phase === "transaction" || upgradeProgress.phase === "hooks";

    return withDetails(
      <Card>
        <CardBody>
          {toastGroup}
          <Flex justifyContent={{ default: "justifyContentSpaceBetween" }} alignItems={{ default: "alignItemsCenter" }}>
            <FlexItem>
              <CardTitle className="pf-v6-u-m-0">Applying updates</CardTitle>
            </FlexItem>
            <FlexItem>
              <Button variant="danger" onClick={handleCancelClick} isDisabled={isCancelling}>
                {isCancelling ? "Cancelling…" : "Cancel"}
              </Button>
            </FlexItem>
          </Flex>

          {isCancelling && (
            <>
              <Content component="p" className="pf-v6-u-mt-md">
                {modifying
                  ? "Cancellation requested: waiting for package changes and hooks to finish"
                  : "Cancellation requested: waiting for the backend to stop safely"}
              </Content>
              <CancellationNotice phase={upgradeProgress.phase} />
            </>
          )}

          <Content className="pf-v6-u-mt-md pf-v6-u-mb-sm">
            <strong>{upgradeProgress.phaseLabel}</strong>
            {upgradeProgress.item && (
              <span style={{ color: "var(--pf-t--global--text--color--subtle)" }}>
                {" "}- {upgradeProgress.item}
              </span>
            )}
          </Content>

          <Progress
            value={progressValue}
            helperText={upgradeProgress.stepLabel}
            measureLocation={progressValue !== undefined ? ProgressMeasureLocation.outside : ProgressMeasureLocation.none}
            aria-label="Upgrade progress"
            valueText={progressValueText(upgradeProgress)}
          />

          {upgradeNeedsReboot && (
            <Checkbox
              id="reboot-on-complete"
              label="Reboot when complete"
              isChecked={rebootOnComplete}
              onChange={(_event, checked) => setRebootOnComplete(checked)}
              className="pf-v6-u-mt-md"
            />
          )}

          {servicesStatus?.restart_required && !upgradeNeedsReboot && (
            <Checkbox
              id="restart-services-on-complete"
              label="Restart affected services when complete"
              isChecked={restartServicesOnComplete}
              onChange={(_event, checked) => setRestartServicesOnComplete(checked)}
              className="pf-v6-u-mt-md"
            />
          )}

          <ExpandableLogViewer
            log={log}
            placeholder="Starting upgrade…"
            isExpanded={isDetailsExpanded}
            onToggle={setIsDetailsExpanded}
            className="pf-v6-u-mt-md"
          />
        </CardBody>

        <ConfirmModal
          isOpen={cancelModalOpen}
          title="Cancel upgrade?"
          severity={modifying ? "danger" : "warning"}
          commitVariant="danger"
          commitLabel={modifying ? "Request cancellation" : "Cancel upgrade"}
          cancelLabel="Continue upgrade"
          onConfirm={confirmCancel}
          onClose={() => setCancelModalOpen(false)}
          commitLoading={isCancelling}
          busy={isCancelling}
        >
          {!modifying ? (
            <Content>
              <Content component={ContentVariants.p}>
                The upgrade has not started modifying your system yet. It is safe to cancel now.
              </Content>
            </Content>
          ) : (
            <Content>
              <Content component={ContentVariants.p}>
                <strong>Warning:</strong> The upgrade is currently {upgradeProgress.phase === "hooks" ? "running hooks" : "installing packages"}.
              </Content>
              <Content component={ContentVariants.p}>
                Package changes and hooks will finish before cancellation completes.
              </Content>
            </Content>
          )}
        </ConfirmModal>
      </Card>
    );
  }

  if (state === "notchecked") {
    return withDetails(
      <Card>
        <CardBody>
          {pageAlerts}
          <EmptyState headingLevel="h2" icon={ExclamationCircleIcon} titleText="Updates not checked" status="warning">
            <EmptyStateBody>
              The last check did not finish, so it is not known whether updates are available.
            </EmptyStateBody>
            <EmptyStateFooter>
              <EmptyStateActions>
                <Button variant="primary" onClick={checkForUpdates}>
                  Check for updates
                </Button>
              </EmptyStateActions>
            </EmptyStateFooter>
          </EmptyState>
        </CardBody>
      </Card>
    );
  }

  if (state === "success") {
    const { counts, skipped, held } = upgradeSummary;
    const done = describeUpgrade(counts, "past");
    const muted = (text: React.ReactNode) => <span className="pf-v6-u-color-200">{text}</span>;
    const blockedLinks = blockedServices.length > 0 && (
      <>
        Restart outside Cockpit:{" "}
        {blockedServices.map((svc, i) => (
          <React.Fragment key={svc.name}>
            {i > 0 && ", "}
            <Button
              variant="link"
              isInline
              aria-label={`Open ${svc.name} in Services`}
              onClick={() => jumpToService(svc.name)}
            >
              {svc.name}
            </Button>
          </React.Fragment>
        ))}
        .
      </>
    );
    const stepFor = (check: PostRunCheck): { text: React.ReactNode; action?: React.ReactNode } | null => {
      switch (check) {
        case "reboot":
          return rebootStatus?.requires_reboot ? {
            text: <><strong>{NOTICE_TITLE.reboot}.</strong> {rebootReason(rebootStatus)}</>,
            action: (
              <GatedButton gate={rebootMutation} variant="primary" icon={<PowerOffIcon />} onClick={() => setRebootConfirmOpen(true)}>
                Reboot now
              </GatedButton>
            ),
          } : null;
        case "services":
          if (restarted) {
            return { text: <>{restartedText(restarted)}.{blockedLinks && <> {blockedLinks}</>}</> };
          }
          return servicesStatus?.restart_required && servicesStatus.services.length > 0 ? {
            text: (
              <>
                <strong>{NOTICE_TITLE.services}.</strong>{" "}
                {safeServices.length > 0 && <>Safe to restart from Cockpit: {safeServices.map((svc) => svc.name).join(", ")}. </>}
                {blockedLinks}
              </>
            ),
            action: safeServices.length > 0 && (
              <GatedButton
                gate={restartMutation}
                variant="secondary"
                isLoading={restarting}
                onClick={() => restartUnits(safeServices.map((svc) => svc.name))}
              >
                {restartLabel(safeServices.length)}
              </GatedButton>
            ),
          } : null;
        case "pacnew":
          return pacnewNeedsReview(pacnewStatus) ? {
            text: (
              <>
                <strong>{pacnewTitle(pacnewStatus)}.</strong>{" "}
                {pacnewSummary(pacnewStatus)}
                <PacnewFileList files={pacnewStatus.files} />
              </>
            ),
            action: <GatedButton gate={reconciliationMutation} variant="secondary" onClick={() => setReconciliationOpen(true)}>Review configuration files</GatedButton>,
          } : null;
        case "orphans": {
          const before = new Set(orphansBefore ?? []);
          const added = orphanNames && orphansBefore ? orphanNames.filter((name) => !before.has(name)) : [];
          const cache = cacheProjection && cacheProjection.files > 0 ? cacheProjection : null;
          if (added.length === 0 && !cache) return null;
          const cacheText = cache && (
            <>
              The package cache holds up to {plural(cache.files, "old file")} ({formatSize(cache.bytes)}) beyond the newest{" "}
              {plural(DEFAULT_KEEP_VERSIONS, "version")} of each package.
            </>
          );
          return {
            text: added.length > 0 ? (
              <>
                <strong>The upgrade left {plural(added.length, "new orphan package")}.</strong>{" "}
                <CollapsedNames names={added} noun="orphan packages" />
                {cacheText && <> {cacheText}</>}
              </>
            ) : (
              <><strong>Old package files can be deleted.</strong> {cacheText}</>
            ),
            action: (
              <Flex spaceItems={{ default: "spaceItemsSm" }}>
                <GatedButton
                  gate={tidyMutation}
                  variant="secondary"
                  onClick={() => setTidyPlan({ orphans: added, cache: cache ?? { files: 0, bytes: 0 } })}
                >
                  Tidy up
                </GatedButton>
                {added.length > 0 && onViewOrphans && <Button variant="link" onClick={onViewOrphans}>Review orphans</Button>}
              </Flex>
            ),
          };
        }
      }
    };
    const rowChecks: PostRunCheck[] = ["reboot", "services", "pacnew", ...(orphansBefore !== null ? ["orphans" as const] : [])];
    const skippedStep = skipped.length > 0 ? {
      key: "skipped",
      text: (
        <>
          <strong>Partial upgrade.</strong> Skipped: <CollapsedNames names={skipped} noun="skipped updates" />
        </>
      ),
      action: (
        <GatedButton
          gate={applyMutation}
          variant="secondary"
          isLoading={resuming}
          onClick={() => {
            if (!resuming) resumeSelection(skipped, "None of the skipped updates are pending any more");
          }}
        >
          Apply the {plural(skipped.length, "skipped update")}
        </GatedButton>
      ),
    } : null;
    const checkRows = postChecks ? rowChecks.map((check) => {
      const status = postChecks[check];
      const copy = CHECK_COPY[check];
      if (status === "pending") {
        return { key: check, text: muted(<><Spinner size="sm" aria-hidden="true" /> {copy.checking}</>) };
      }
      if (status === "failed") return { key: check, text: muted(copy.failed) };
      return { key: check, ...(stepFor(check) ?? { text: muted(copy.clear) }) };
    }) : [];
    const rows = checkRows.length > 0 && skippedStep ? [skippedStep, ...checkRows] : checkRows;
    const nextSteps = rows.length > 0 && (
      <section aria-labelledby="updates-next-steps" className="pf-v6-u-mt-lg pf-v6-u-text-align-left">
        <Content component={ContentVariants.h3} id="updates-next-steps">Next steps</Content>
        {servicesPartialAlert}
        <List isPlain isBordered aria-labelledby="updates-next-steps">
          {rows.map((row) => (
            <ListItem key={row.key}>
              <Flex
                justifyContent={{ default: "justifyContentSpaceBetween" }}
                alignItems={{ default: "alignItemsCenter" }}
                flexWrap={{ default: "wrap" }}
              >
                <FlexItem flex={{ default: "flex_1" }}>{row.text}</FlexItem>
                {"action" in row && row.action && <FlexItem>{row.action}</FlexItem>}
              </Flex>
            </ListItem>
          ))}
        </List>
      </section>
    );
    return withDetails(
      <Card>
        <CardBody>
          <EmptyState  headingLevel="h2" icon={CheckCircleIcon}  titleText="System updated">
            <EmptyStateBody>
              {skipped.length > 0 ? (
                <>
                  {done}.{" "}
                  {plural(skipped.length, "update was", "updates were")} skipped.
                  Partial upgrades are unsupported and may cause dependency issues.
                </>
              ) : held > 0 ? (
                <>
                  {done}.{" "}
                  {plural(held, "package is", "packages are")} ignored.
                </>
              ) : `${done}.`}
            </EmptyStateBody>
            {nextSteps}
            <EmptyStateFooter>
              <EmptyStateActions>
                <Button variant="secondary" onClick={() => loadUpdates(true)}>
                  Check again
                </Button>
              </EmptyStateActions>
            </EmptyStateFooter>
          </EmptyState>
          {!nextSteps && servicesPartialAlert}
          {pageAlerts}
          {log && <LogViewer log={log} className="pf-v6-u-mt-md" />}
          {tidyPlan && (
            <TidyUpModal
              onClose={() => setTidyPlan(null)}
              orphans={tidyPlan.orphans}
              cache={tidyPlan.cache}
              gate={tidyMutation}
              onFinished={() => { loadOverview(); }}
            />
          )}
        </CardBody>
      </Card>
    );
  }

  if (state === "uptodate") {
    return withDetails(
      <>
        {skipLink}
        {pageAlerts}
        <WarningsAlert title={warnings.length === 1 ? "Warning" : "Warnings"} warnings={warnings} />
        {newsErrorAlert}
        {securityStaleAlert}
        {newsAlerts}
        {keyringUninitializedAlert}
        <KeyringWarnings warnings={keyringStatus?.warnings ?? []} />

        <SystemOverviewCard
          updates={updates}
          securityCount={securityUpdateCount}
          securityLoading={securityLoading}
          securityUnavailable={securityUnavailable}
          orphanCount={orphanCount}
          cacheSize={cacheSize}
          keyringStatus={keyringStatus}
          summaryLoading={summaryLoading}
          pendingSignoffs={signoffCredentials ? toSignOff : null}
          securityEnabled={securityEnabled}
          onSetSecurityEnabled={handleSetSecurityEnabled}
          securityToggleBusy={savingSecurityToggle}
          securityToggleError={securityToggleError}
          key="overview"
        />

        <Card className="pf-v6-u-mb-md">
          <CardBody style={{ paddingBottom: 0 }}>
            <Toolbar>
              <ToolbarContent>
                <ToolbarItem>
                  <GatedButton
                    gate={scheduleGate}
                    variant="secondary"
                    onClick={() => setScheduleModalOpen(true)}
                  >
                    Manage Schedule
                  </GatedButton>
                </ToolbarItem>
                <ToolbarItem>
                  <GatedButton
                    gate={ignoredMutation}
                    variant="secondary"
                    onClick={() => openIgnoredModal()}
                  >
                    Manage ignored{ignoredCount > 0 ? ` (${ignoredCount})` : ""}
                  </GatedButton>
                </ToolbarItem>
                <ToolbarItem>
                  <GatedButton
                    gate={refreshMutation}
                    variant="secondary"
                    icon={<SyncAltIcon />}
                    onClick={() => {
                      autoResumedRef.current = false;
                      handleRefresh();
                    }}
                  >
                    Refresh
                  </GatedButton>
                </ToolbarItem>
                {databaseAgeItem}
              </ToolbarContent>
            </Toolbar>
          </CardBody>
        </Card>

        <Card>
          <CardBody>
            <EmptyState
              headingLevel="h2"
              icon={databaseTimes.oldestDatabaseAt === null ? ExclamationTriangleIcon : CheckCircleIcon}
              status={databaseTimes.oldestDatabaseAt === null ? "warning" : undefined}
              titleText={upToDateHeading(adminAllowed, databaseTimes)}
            >
              <EmptyStateBody>
                {databaseTimes.oldestDatabaseAt === null
                  ? "No newer packages in the package databases that have been synced."
                  : <>{databaseAge(databaseTimes, "No newer packages found when last checked", "No newer packages in package databases from")}.</>}
                {adminAllowed === false && " Turn on administrative access to check the mirrors for newer packages."}
              </EmptyStateBody>
            </EmptyState>
          </CardBody>
        </Card>

        {ignoredModal}
      </>
    );
  }

  return (
    <>
      {skipLink}
      {pageAlerts}
      <WarningsAlert title={warnings.length === 1 ? "Warning" : "Warnings"} warnings={warnings} />
      {newsErrorAlert}
      {securityStaleAlert}
      {newsAlerts}
      {keyringUninitializedAlert}
      <KeyringWarnings warnings={keyringStatus?.warnings ?? []} />
      {deselectedPackages.length > 0 && (
        <Alert
          variant="warning"
          title="Partial upgrade"
          isInline
          className="pf-v6-u-mb-md"
          actionLinks={
            <AlertActionLink
              onClick={() => {
                selectAllPackages();
                applyButtonRef.current?.focus();
              }}
            >
              Select all
            </AlertActionLink>
          }
        >
          Skipping {plural(deselectedPackages.length, "package")}. Partial upgrades are unsupported and may cause dependency issues.
        </Alert>
      )}
      <SystemOverviewCard
        updates={updates}
        securityCount={securityUpdateCount}
        securityLoading={securityLoading}
        securityUnavailable={securityUnavailable}
        orphanCount={orphanCount}
        cacheSize={cacheSize}
        keyringStatus={keyringStatus}
        summaryLoading={summaryLoading}
        pendingSignoffs={signoffCredentials ? toSignOff : null}
        securityFilterActive={securityFilterOn}
        onToggleSecurityFilter={() => setSecurityFilterActive((v) => !v)}
        securityEnabled={securityEnabled}
        onSetSecurityEnabled={handleSetSecurityEnabled}
        securityToggleBusy={savingSecurityToggle}
        securityToggleError={securityToggleError}
        key="overview"
      />

      {heldPackages.length > 0 && !allHeld && (
        <Flex
          spaceItems={{ default: "spaceItemsSm" }}
          alignItems={{ default: "alignItemsCenter" }}
          className="pf-v6-u-mb-md pf-v6-u-font-size-sm"
        >
          <FlexItem>{plural(heldPackages.length, "package", "packages")} ignored</FlexItem>
          <FlexItem>{manageIgnoredLink}</FlexItem>
        </Flex>
      )}

      {allHeld ? withDetails(
        <Card>
          <CardBody>
            <EmptyState headingLevel="h2" icon={ExclamationTriangleIcon} titleText="All available updates are ignored">
              <EmptyStateBody>
                {plural(heldPackages.length, "pending update is", "pending updates are")} excluded by your ignore settings.
                Unignore a package to include it in an upgrade.
              </EmptyStateBody>
              <EmptyStateFooter>
                <EmptyStateActions>
                  {manageIgnoredLink}
                  <GatedButton gate={refreshMutation} variant="secondary" onClick={checkForUpdates}>
                    Check for updates
                  </GatedButton>
                </EmptyStateActions>
              </EmptyStateFooter>
            </EmptyState>
          </CardBody>
        </Card>
      ) : (
      <Card>
        <div ref={listHeaderRef} id="updates-list-header" tabIndex={-1}>
          <CardHeader actions={{ actions: applyButton, hasNoOffset: true }}>
            <CardTitle>
              {(selectedPackages.size).toLocaleString()} of {plural(updates.length, "update")} selected
              {filteredUpdates.length !== updates.length && ` (${(filteredUpdates.length).toLocaleString()} shown)`}
            </CardTitle>
            <Content component={ContentVariants.small}>
              {formatTotalsLine(cardTotals)}
              {lastCheckedLine}
            </Content>
          </CardHeader>
        </div>
        <CardBody>
        {withDetails(
        <>
          <Toolbar className="pf-v6-u-px-0">
            <ToolbarContent>
              <ToolbarItem>
                <SearchInput
                  placeholder="Filter updates…"
                  value={searchFilter}
                  onChange={(_event: React.SyntheticEvent, value: string) => setSearchFilter(value)}
                  onClear={() => setSearchFilter("")}
                  aria-label="Filter updates"
                />
              </ToolbarItem>
              {securityFilterOn && (
                <ToolbarItem alignSelf="center">
                  <Button
                    variant="link"
                    isInline
                    onClick={selectOnlyVisible}
                    isDisabled={visibleSelectable.length === 0}
                  >
                    Select only these ({visibleSelectable.length.toLocaleString()})
                  </Button>
                </ToolbarItem>
              )}
              {repositories.length > 1 && (
                <ToolbarItem>
                  <Select
                    isOpen={repoSelectOpen}
                    selected={repoFilter}
                    onSelect={(_event: React.MouseEvent | undefined, value: string | number | undefined) => {
                      setRepoFilter(value as string);
                      setRepoSelectOpen(false);
                    }}
                    onOpenChange={setRepoSelectOpen}
                    toggle={(toggleRef: React.Ref<MenuToggleElement>) => (
                      <MenuToggle
                        ref={toggleRef}
                        onClick={() => setRepoSelectOpen(!repoSelectOpen)}
                        isExpanded={repoSelectOpen}
                        aria-label="Filter by repository"
                      >
                        {repoFilter === "all" ? "All repositories" : repoFilter}
                      </MenuToggle>
                    )}
                  >
                    <SelectList>
                      <SelectOption value="all">All repositories</SelectOption>
                      {repositories.map((repo) => (
                        <SelectOption key={repo} value={repo}>
                          {repo}
                        </SelectOption>
                      ))}
                    </SelectList>
                  </Select>
                </ToolbarItem>
              )}
              <ToolbarItem>
                <GatedButton
                  gate={scheduleGate}
                  variant="secondary"
                  onClick={() => setScheduleModalOpen(true)}
                >
                  Manage Schedule
                </GatedButton>
              </ToolbarItem>
              <ToolbarItem>
                <GatedButton
                  gate={ignoredMutation}
                  variant="secondary"
                  onClick={() => openIgnoredModal()}
                >
                  Manage ignored{ignoredCount > 0 ? ` (${ignoredCount})` : ""}
                </GatedButton>
              </ToolbarItem>
              <ToolbarItem>
                <GatedButton
                  gate={refreshMutation}
                  variant="secondary"
                  icon={<SyncAltIcon />}
                  onClick={() => {
                    autoResumedRef.current = false;
                    handleRefresh();
                  }}
                >
                  Refresh
                </GatedButton>
              </ToolbarItem>
              {databaseAgeItem}
            </ToolbarContent>
          </Toolbar>

        <Table aria-label="Available updates" variant="compact" ref={tableRef}>
          <Thead>
            <Tr>
              <Th screenReaderText="Select">
                <Checkbox
                  id="select-all-updates"
                  isChecked={areAllSelected}
                  onChange={(_event, checked) => checked ? selectAllPackages() : deselectAllPackages()}
                  aria-label={`Select all ${plural(selectableCount, "update")}`}
                />
              </Th>
              <Th sort={getSortParams("name")}>Package</Th>
              <Th sort={getSortParams("repo")}>Repository</Th>
              <Th>Version</Th>
              <Th sort={getSortParams("download")}>Download</Th>
              <Th sort={getSortParams("installed")}>Installed</Th>
              <Th
                sort={getSortParams("net")}
                info={{
                  popover: "Change in installed size after this update. + means the package grows, \u2212 means it shrinks.",
                  ariaLabel: "More information about Net size",
                }}
              >
                Net
              </Th>
              <Th screenReaderText="Actions" />
            </Tr>
          </Thead>
          <Tbody>
            {pagedUpdates.map((update) => {
              const netSize = update.new_size - update.current_size;
              const isSelected = selectedPackages.has(update.name);
              const isIgnored = update.ignored;
              const partition = partitionAdvisories(securityMap.get(update.name) ?? []);
              const highest = highestOf(partition.actionable);
              const borderColor = highest
                ? `var(--pf-t--global--color--status--${highest.severity === "Critical" || highest.severity === "High" ? "danger" : "warning"}--default)`
                : undefined;
              const openRow = detailsRowProps(detailsName === update.name);
              return (
                <Tr
                  key={update.name}
                  isClickable
                  onRowClick={(event) => !fromRowActions(event) && handlePackageClick(update.name)}
                  isRowSelected={isSelected}
                  {...openRow}
                  style={{
                    ...(borderColor ? { borderLeft: `3px solid ${borderColor}` } : {}),
                    ...openRow.style,
                  }}
                >
                  <RowSelectCell
                    label={`Select ${update.name}`}
                    isSelected={isSelected}
                    isDisabled={isIgnored}
                    description={isIgnored ? "Ignored during upgrades" : undefined}
                    onSelect={() => togglePackageSelection(update.name)}
                  />
                  <Td dataLabel="Package">
                    <Button variant="link" isInline className="pf-v6-u-p-0" {...{ [DETAILS_TRIGGER_ATTR]: update.name }}>
                      {update.name}
                    </Button>
                    {newNames.has(update.name) && (
                      <Label color="blue" isCompact className="pf-v6-u-ml-sm">New</Label>
                    )}
                    {isIgnored && (
                      <IgnoredLabel name={update.name} gate={ignoredMutation.reason} onOpen={() => openIgnoredModal(update.name)} />
                    )}
                    {(partition.actionable.length > 0 || partition.unresolved.length > 0) && (
                      <AdvisoryPopover partition={partition} />
                    )}
                  </Td>
                  <Td dataLabel="Repository">
                    <Label isCompact color="grey">{update.repository}</Label>
                  </Td>
                  <Td dataLabel="Version">{update.current_version} {"\u2192"} {update.new_version}</Td>
                  <Td dataLabel="Download">{formatSize(update.download_size)}</Td>
                  <Td dataLabel="Installed size">{formatSize(update.new_size)}</Td>
                  <Td dataLabel="Net" style={{ color: netSize > 0 ? "var(--pf-t--global--color--status--danger--default)" : netSize < 0 ? "var(--pf-t--global--color--status--success--default)" : undefined }}>
                    {netSize > 0 && <ArrowUpIcon style={{ marginRight: "0.25rem" }} />}
                    {netSize < 0 && <ArrowDownIcon style={{ marginRight: "0.25rem" }} />}
                    {signedSize(netSize)}
                  </Td>
                  <Td isActionCell>
                    <PackageRowActions
                      name={update.name}
                      installedVersion={update.current_version}
                      repository={update.repository}
                      syncVersion={update.new_version}
                      ignored={isIgnored}
                      onViewDetails={() => handlePackageClick(update.name)}
                      onIgnoreChange={(ignore) => handleIgnoreChange(update.name, ignore)}
                      ignoreGate={isIgnored ? ignoredMutation : ignoreMutation}
                    />
                  </Td>
                </Tr>
              );
            })}
          </Tbody>
        </Table>
        {sortedUpdates.length > perPage && (
          <CompactPagination
            itemCount={sortedUpdates.length}
            page={page}
            perPage={perPage}
            onSetPage={onSetPage}
            onPerPageSelect={onPerPageSelect}
          />
        )}
        </>
        )}
        </CardBody>
      </Card>
      )}

      <NavigationProvider value={confirmNavigation}>
        <PreflightConfirmModal
          isOpen={confirmModalOpen}
          preflight={preflightData}
          packages={selectedUpdates}
          skipped={deselectedPackages}
          onClose={closePreflight}
          onProceed={() => startUpgrade()}
          onRefresh={refreshPreview}
          refreshing={previewRefreshing}
          initiallyStale={confirmOpensStale}
        />
      </NavigationProvider>

      {ignoredModal}
    </>
  );
};
