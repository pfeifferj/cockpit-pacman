import React, { useState, useEffect, useCallback, useRef, useMemo } from "react";
import { ARCH_STATUS_URL, LOG_CONTAINER_HEIGHT, MAX_LOG_SIZE_BYTES, NEWS_LOOKBACK_DAYS, REBOOT_PACKAGES } from "../constants";
import { useAutoScrollLog } from "../hooks/useAutoScrollLog";
import { useBackdropClose } from "../hooks/useBackdropClose";
import { usePackageDetails } from "../hooks/usePackageDetails";
import { useSortableTable } from "../hooks/useSortableTable";
import {
	Card,
	CardBody,
	CardTitle,
	Button,
	Alert,
	AlertActionCloseButton,
	EmptyState,
	EmptyStateBody,
	EmptyStateActions,
	EmptyStateFooter,
	Spinner,
	Progress,
	ProgressMeasureLocation,
	CodeBlock,
	CodeBlockCode,
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
	Dropdown,
	DropdownList,
	DropdownItem,
	List,
	ListItem,
	Content,
	ContentVariants,
	ExpandableSection,
	Checkbox,
	Modal,
	ModalVariant,
	ModalHeader,
	ModalBody,
	ModalFooter,
	Popover,
	Tooltip,
	Icon,
} from '@patternfly/react-core';
import {
  CheckCircleIcon,
  ExclamationCircleIcon,
  ShieldAltIcon,
  SyncAltIcon,
  ArrowUpIcon,
  ArrowDownIcon,
  OutlinedQuestionCircleIcon,
  PowerOffIcon,
  EllipsisVIcon,
} from "@patternfly/react-icons";
import { Table, Thead, Tr, Th, Tbody, Td } from "@patternfly/react-table";
import {
  UpdateInfo,
  PreflightResponse,
  StreamEvent,
  RebootStatus,
  ServiceRestart,
  ServicesStatus,
  KeyringStatusResponse,
  NewsItem,
  PackageSecurityAdvisory,
  checkUpdates,
  checkSecurity,
  runUpgrade,
  syncDatabase,
  preflightUpgrade,
  formatSize,
  formatNumber,
  getRebootStatus,
  rebootSystem,
  getServicesStatus,
  restartServices,
  listOrphans,
  getCacheInfo,
  getKeyringStatus,
  fetchNews,
  getNewsReadState,
  markNewsRead,
  getServicesDismissal,
  markServicesDismissed,
  addIgnoredPackage,
  getSignoffList,
  checkLock,
  removeStaleLock,
} from "../api";
import type { KeyringCredentials } from "../api";

import { sanitizeUrl } from "../utils";
import { TimeAgo } from "./TimeAgo";
import { PackageDetailsModal } from "./PackageDetailsModal";
import { StatBox } from "./StatBox";
import { IgnoredPackagesModal } from "./IgnoredPackagesModal";
import { ScheduleModal } from "./ScheduleModal";
import { useNavigation } from "../contexts/NavigationContext";

const SEVERITY_ORDER: Record<string, number> = {
  Critical: 4,
  High: 3,
  Medium: 2,
  Low: 1,
  Unknown: 0,
};

type SeverityColor = "red" | "orange" | "yellow" | "blue" | "grey";

function severityColor(severity: string): SeverityColor {
  switch (severity) {
    case "Critical": return "red";
    case "High": return "orange";
    case "Medium": return "yellow";
    case "Low": return "blue";
    default: return "grey";
  }
}

type PageStatus = {
  type?: "info" | "warning" | "error" | null;
  title: string;
  details?: { pficon?: string; link?: false };
};

function publishPageStatus(status: PageStatus | null): void {
  cockpit.transport.control("notify", { page_status: status });
}

interface UpgradeProgress {
  phase: "preparing" | "downloading" | "installing" | "hooks";
  current: number;
  total: number;
  currentPackage: string;
  percent: number;
}

type ViewState =
  | "loading"
  | "checking"
  | "uptodate"
  | "available"
  | "applying"
  | "success"
  | "error";

const SystemOverviewCard: React.FC<{
  updates: UpdateInfo[];
  securityCount: number;
  securityLoading: boolean;
  orphanCount: number | null;
  cacheSize: number | null;
  keyringStatus: KeyringStatusResponse | null;
  summaryLoading: boolean;
  pendingSignoffs?: number | null;
}> = ({ updates, securityCount, securityLoading, orphanCount, cacheSize, keyringStatus, summaryLoading, pendingSignoffs }) => {
  const { onViewOrphans, onViewCache, onViewKeyring, onViewSignoffs } = useNavigation();
  return (
  <Card className="pf-v6-u-mb-md">
    <CardBody>
      <CardTitle className="pf-v6-u-m-0 pf-v6-u-mb-md">System Overview</CardTitle>
      <Flex spaceItems={{ default: "spaceItemsLg" }}>
        <FlexItem>
          <StatBox
            label="Updates"
            value={formatNumber(updates.length)}
            color={updates.length > 0 ? "danger" : "success"}
          />
        </FlexItem>
        <FlexItem>
          <StatBox
            label="Security"
            value={securityLoading ? "-" : formatNumber(securityCount)}
            color={securityCount > 0 ? "danger" : "default"}
            isLoading={securityLoading}
          />
        </FlexItem>
        <FlexItem>
          <Tooltip content="Packages installed as dependencies that are no longer required by any other package. Usually safe to remove.">
            <div>
              <StatBox
                label="Orphans"
                value={orphanCount !== null ? formatNumber(orphanCount) : "-"}
                color={orphanCount && orphanCount > 0 ? "warning" : "default"}
                isLoading={summaryLoading}
                onClick={onViewOrphans}
                ariaLabel="View orphaned packages"
              />
            </div>
          </Tooltip>
        </FlexItem>
        <FlexItem>
          <StatBox
            label="Cache"
            value={cacheSize !== null ? formatSize(cacheSize) : "-"}
            isLoading={summaryLoading}
            onClick={onViewCache}
            ariaLabel="View package cache"
          />
        </FlexItem>
        <FlexItem>
          <StatBox
            label="Keyring"
            value={keyringStatus ? `${keyringStatus.total} keys` : "-"}
            color={keyringStatus?.warnings.length ? "warning" : "default"}
            isLoading={summaryLoading}
            onClick={onViewKeyring}
            ariaLabel="View keyring"
          />
        </FlexItem>
        {pendingSignoffs != null && onViewSignoffs && (
          <FlexItem>
            <Tooltip content="Packages in [testing] repositories waiting for Trusted User signoffs before moving to stable.">
              <div>
                <StatBox
                  label="Signoffs"
                  value={formatNumber(pendingSignoffs)}
                  color={pendingSignoffs > 0 ? "info" : "default"}
                  onClick={onViewSignoffs}
                  ariaLabel="View package signoffs"
                />
              </div>
            </Tooltip>
          </FlexItem>
        )}
      </Flex>
    </CardBody>
  </Card>
  );
};

interface UpdatesViewProps {
  signoffCredentials?: KeyringCredentials | null;
}

const LockErrorBody: React.FC<{ onRetry: () => void }> = ({ onRetry }) => {
  const [checking, setChecking] = useState(false);
  const [removing, setRemoving] = useState(false);
  const [lockInfo, setLockInfo] = useState<{ stale: boolean; process?: string } | null>(null);
  const [removeError, setRemoveError] = useState<string | null>(null);

  useEffect(() => {
    setChecking(true);
    checkLock()
      .then((status) => {
        if (!status.locked) {
          onRetry();
          return;
        }
        setLockInfo({ stale: status.stale, process: status.blocking_process });
      })
      .catch(() => setLockInfo(null))
      .finally(() => setChecking(false));
  }, [onRetry]);

  const handleRemoveLock = async () => {
    setRemoving(true);
    setRemoveError(null);
    try {
      const result = await removeStaleLock();
      if (result.removed) {
        onRetry();
      } else {
        setRemoveError(result.error || "Failed to remove lock");
      }
    } catch (ex) {
      setRemoveError(ex instanceof Error ? ex.message : String(ex));
    } finally {
      setRemoving(false);
    }
  };

  if (checking) {
    return <Content component={ContentVariants.p}>Checking lock status...</Content>;
  }

  if (lockInfo?.stale === false && lockInfo.process) {
    return (
      <Content component={ContentVariants.p}>
        The database is locked by <strong>{lockInfo.process}</strong>. Wait for it to finish, then retry.
      </Content>
    );
  }

  return (
    <>
      <Content component={ContentVariants.p}>
        A stale lock file is blocking database access. No package manager process is running.
      </Content>
      {removeError && (
        <Content component={ContentVariants.p} className="pf-v6-u-mt-sm pf-v6-u-danger-color-100">
          {removeError}
        </Content>
      )}
      <Content component={ContentVariants.p} className="pf-v6-u-mt-sm">
        <Button variant="primary" onClick={handleRemoveLock} isLoading={removing} isDisabled={removing}>
          Remove stale lock and retry
        </Button>
      </Content>
    </>
  );
};

export const UpdatesView: React.FC<UpdatesViewProps> = ({ signoffCredentials }) => {
  const { onViewDependencies, onViewHistory } = useNavigation();
  const [state, setState] = useState<ViewState>("loading");
  const [updates, setUpdates] = useState<UpdateInfo[]>([]);
  const [log, setLog] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [warnings, setWarnings] = useState<string[]>([]);
  const cancelRef = useRef<(() => void) | null>(null);
  const logContainerRef = useAutoScrollLog(log);
  const { selectedPackage, detailsLoading: packageLoading, detailsError, fetchDetails, clearDetails } = usePackageDetails();
  const [searchFilter, setSearchFilter] = useState("");
  const [repoFilter, setRepoFilter] = useState("all");
  const [repoSelectOpen, setRepoSelectOpen] = useState(false);
  const [confirmModalOpen, setConfirmModalOpen] = useState(false);
  useBackdropClose(confirmModalOpen, () => setConfirmModalOpen(false));
  const [preflightData, setPreflightData] = useState<PreflightResponse | null>(null);
  const [preflightLoading, setPreflightLoading] = useState(false);
  const [selectedPackages, setSelectedPackages] = useState<Set<string>>(new Set());
  const [upgradeProgress, setUpgradeProgress] = useState<UpgradeProgress>({
    phase: "preparing",
    current: 0,
    total: 0,
    currentPackage: "",
    percent: 0,
  });
  const [isDetailsExpanded, setIsDetailsExpanded] = useState(false);
  const [cancelModalOpen, setCancelModalOpen] = useState(false);
  useBackdropClose(cancelModalOpen, () => setCancelModalOpen(false));
  const [isCancelling, setIsCancelling] = useState(false);
  const [ignoredModalOpen, setIgnoredModalOpen] = useState(false);
  const [openKebab, setOpenKebab] = useState<string | null>(null);
  const [scheduleModalOpen, setScheduleModalOpen] = useState(false);
  const [acknowledgedRemovals, setAcknowledgedRemovals] = useState(false);
  const [acknowledgedConflicts, setAcknowledgedConflicts] = useState(false);
  const [acknowledgedKeyImports, setAcknowledgedKeyImports] = useState(false);
  const [acknowledgedWarnings, setAcknowledgedWarnings] = useState<Set<string>>(new Set());
  const [rebootStatus, setRebootStatus] = useState<RebootStatus | null>(null);
  const [rebootOnComplete, setRebootOnComplete] = useState(false);
  const [servicesStatus, setServicesStatus] = useState<ServicesStatus | null>(null);
  const [restartServicesOnComplete, setRestartServicesOnComplete] = useState(false);
  const [dismissedServicesSignature, setDismissedServicesSignature] = useState<string | null | undefined>(undefined);
  const [orphanCount, setOrphanCount] = useState<number | null>(null);
  const [cacheSize, setCacheSize] = useState<number | null>(null);
  const [keyringStatus, setKeyringStatus] = useState<KeyringStatusResponse | null>(null);
  const [pendingSignoffs, setPendingSignoffs] = useState<number | null>(null);
  const [summaryLoading, setSummaryLoading] = useState(true);
  const [securityMap, setSecurityMap] = useState<Map<string, PackageSecurityAdvisory[]>>(new Map());
  const [securityLoading, setSecurityLoading] = useState(true);
  const [newsItems, setNewsItems] = useState<NewsItem[]>([]);
  const [newsError, setNewsError] = useState(false);
  const [dismissedNews, setDismissedNews] = useState<Set<string>>(new Set<string>());

  useEffect(() => {
    let cancelled = false;
    getNewsReadState()
      .then((data) => {
        if (!cancelled) {
          setDismissedNews(new Set(data.dismissed));
        }
      })
      .catch(() => { /* ignore: persistence unavailable */ });
    return () => { cancelled = true; };
  }, []);

  const { activeSortKey, activeSortDirection, getSortParams } = useSortableTable({
    columns: { name: 1, repo: 2, download: 4, installed: 5, net: 6 },
    defaultDirection: "asc",
  });

  const repositories = useMemo(() => {
    const repos = new Set(updates.map((u) => u.repository));
    return Array.from(repos).sort();
  }, [updates]);

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
    return result;
  }, [updates, searchFilter, repoFilter]);

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

  // Calculate ignored packages (unselected ones)
  const ignoredPackages = useMemo(() => {
    return updates.filter((u) => !selectedPackages.has(u.name)).map((u) => u.name);
  }, [updates, selectedPackages]);

  // Calculate selected updates for summary
  const selectedUpdates = useMemo(() => {
    return updates.filter((u) => selectedPackages.has(u.name));
  }, [updates, selectedPackages]);

  const upgradeNeedsReboot = useMemo(() => {
    return updates.some((u) => selectedPackages.has(u.name) && REBOOT_PACKAGES.has(u.name));
  }, [updates, selectedPackages]);

  // Check if all required acknowledgments are made for dangerous operations
  const allDangerousActionsAcknowledged = useMemo(() => {
    if (!preflightData) return true;
    const needsRemovalAck = (preflightData.removals?.length ?? 0) > 0;
    const needsConflictAck = (preflightData.conflicts?.length ?? 0) > 0;
    const needsKeyImportAck = (preflightData.import_keys?.length ?? 0) > 0;
    const warningsNeedingAck = (preflightData.warnings ?? []).filter(
      (w) => w.severity === "warning" || w.severity === "danger"
    );
    const allWarningsAcked = warningsNeedingAck.every((w) => acknowledgedWarnings.has(w.id));
    return (
      (!needsRemovalAck || acknowledgedRemovals) &&
      (!needsConflictAck || acknowledgedConflicts) &&
      (!needsKeyImportAck || acknowledgedKeyImports) &&
      allWarningsAcked
    );
  }, [preflightData, acknowledgedRemovals, acknowledgedConflicts, acknowledgedKeyImports, acknowledgedWarnings]);

  const securityUpdateCount = useMemo(() => {
    return updates.filter((u) => securityMap.has(u.name)).length;
  }, [updates, securityMap]);

  const visibleNews = useMemo(
    () => newsItems.filter((item) => !dismissedNews.has(item.link)),
    [newsItems, dismissedNews]
  );

  const dismissNewsItem = useCallback((link: string) => {
    setDismissedNews((prev) => {
      const next = new Set(prev);
      next.add(link);
      return next;
    });
    void markNewsRead(link).catch(() => { /* ignore: persistence unavailable */ });
  }, []);

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

  const areAllSelected = selectedPackages.size === updates.length && updates.length > 0;
  const areSomeSelected = selectedPackages.size > 0 && selectedPackages.size < updates.length;

  useEffect(() => {
    const el = document.getElementById("select-all-updates") as HTMLInputElement | null;
    if (el) el.indeterminate = areSomeSelected;
  }, [areSomeSelected, areAllSelected]);
  const ignoredCount = useMemo(
    () => updates.filter((u) => u.ignored).length,
    [updates]
  );
  const ignoredNameSet = useMemo(
    () => new Set(updates.filter((u) => u.ignored).map((u) => u.name)),
    [updates]
  );

  const loadSecurityData = useCallback(async () => {
    setSecurityLoading(true);
    try {
      const response = await checkSecurity();
      const map = new Map<string, PackageSecurityAdvisory[]>();
      for (const advisory of response.advisories) {
        const existing = map.get(advisory.package) ?? [];
        existing.push(advisory);
        map.set(advisory.package, existing);
      }
      setSecurityMap(map);
    } catch {
      setSecurityMap(new Map());
    } finally {
      setSecurityLoading(false);
    }
  }, []);

  const loadUpdates = useCallback(async () => {
    setState("checking");
    setError(null);
    setWarnings([]);
    publishPageStatus({
      type: null,
      title: "Checking for package updates\u2026",
      details: { pficon: "spinner", link: false },
    });
    try {
      const response = await checkUpdates();
      setUpdates(response.updates);
      setWarnings(response.warnings);
      setState(response.updates.length > 0 ? "available" : "uptodate");
      loadSecurityData();
      const count = response.updates.length;
      if (count === 0) {
        publishPageStatus({
          type: null,
          title: "System is up to date",
          details: { pficon: "check", link: false },
        });
      } else {
        publishPageStatus({
          type: "info",
          title: `${count} ${count === 1 ? "update" : "updates"} available`,
          details: { pficon: "enhancement" },
        });
      }
    } catch (ex) {
      setState("error");
      setError(ex instanceof Error ? ex.message : String(ex));
      publishPageStatus({
        type: "error",
        title: "Failed to check for package updates",
      });
    }
  }, [loadSecurityData]);

  useEffect(() => {
    const { cancel } = syncDatabase({
      onData: (data) => setLog((prev) => {
        const newLog = prev + data;
        return newLog.length > MAX_LOG_SIZE_BYTES ? newLog.slice(-MAX_LOG_SIZE_BYTES) : newLog;
      }),
      onComplete: () => loadUpdates(),
      onError: (err) => {
        setState("error");
        setError(err);
      },
    });
    return () => cancel();
  }, [loadUpdates]);

  const loadRebootStatus = useCallback(async () => {
    try {
      const status = await getRebootStatus();
      setRebootStatus(status);
    } catch {
      setRebootStatus(null);
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

  useEffect(() => {
    getServicesDismissal()
      .then((d) => setDismissedServicesSignature(d.signature))
      .catch(() => setDismissedServicesSignature(null));
  }, []);

  useEffect(() => {
    loadRebootStatus();
    loadServicesStatus();
  }, [loadRebootStatus, loadServicesStatus]);

  const loadSummary = useCallback(async () => {
    setSummaryLoading(true);
    type NewsResult = { ok: true; items: NewsItem[] } | { ok: false };
    const [orphans, cache, keyring, newsResult] = await Promise.all([
      listOrphans().catch(() => null),
      getCacheInfo().catch(() => null),
      getKeyringStatus().catch(() => null),
      fetchNews(NEWS_LOOKBACK_DAYS)
        .then((r): NewsResult => ({ ok: true, items: r.items }))
        .catch((): NewsResult => ({ ok: false })),
    ]);
    setOrphanCount(orphans?.orphans.length ?? null);
    setCacheSize(cache?.total_size ?? null);
    setKeyringStatus(keyring);
    if (newsResult.ok) {
      setNewsError(false);
      setNewsItems(newsResult.items);
    } else {
      setNewsError(true);
      setNewsItems([]);
    }
    setSummaryLoading(false);
  }, []);

  useEffect(() => {
    loadSummary();
  }, [loadSummary]);

  useEffect(() => {
    if (!signoffCredentials) return;
    getSignoffList(signoffCredentials)
      .then((res) => {
        setPendingSignoffs(res.signoff_groups.filter((g) => !g.approved && !g.known_bad).length);
      })
      .catch(() => {
        setPendingSignoffs(null);
      });
  }, [signoffCredentials]);

  // Track whether we've done initial selection
  const hasInitializedSelection = useRef(false);

  // Initialize selected packages when updates load, excluding ignored packages
  // On subsequent loads, preserve user selections
  useEffect(() => {
    if (updates.length === 0) {
      hasInitializedSelection.current = false;
      return;
    }

    if (hasInitializedSelection.current) {
      setSelectedPackages((prev) => {
        const nonIgnoredNames = new Set(
          updates.filter((u) => !u.ignored).map((u) => u.name)
        );
        const next = new Set<string>();
        for (const pkg of prev) {
          if (nonIgnoredNames.has(pkg)) {
            next.add(pkg);
          }
        }
        return next;
      });
      return;
    }

    const nonIgnored = updates
      .filter((u) => !u.ignored)
      .map((u) => u.name);
    setSelectedPackages(new Set(nonIgnored));
    hasInitializedSelection.current = true;
  }, [updates]);

  useEffect(() => {
    return () => {
      if (cancelRef.current) {
        cancelRef.current();
      }
    };
  }, []);


  const handleRefresh = async () => {
    if (cancelRef.current) {
      cancelRef.current();
    }
    setState("checking");
    setLog("");
    setSelectedPackages(new Set());
    const { cancel } = syncDatabase({
      onData: (data) => setLog((prev) => {
        const newLog = prev + data;
        return newLog.length > MAX_LOG_SIZE_BYTES ? newLog.slice(-MAX_LOG_SIZE_BYTES) : newLog;
      }),
      onComplete: () => loadUpdates(),
      onError: (err) => {
        setState("error");
        setError(err);
      },
    });
    cancelRef.current = cancel;
  };

  const handleApplyUpdates = async () => {
    // Run preflight check first
    setPreflightLoading(true);
    setError(null);
    try {
      const preflight = await preflightUpgrade(ignoredPackages);
      setPreflightData(preflight);
      setPreflightLoading(false);

      if (!preflight.success) {
        setError(preflight.error || "Preflight check failed");
        setState("error");
        return;
      }

      // Check if there are any issues needing confirmation
      const hasIssues =
        (preflight.conflicts?.length ?? 0) > 0 ||
        (preflight.replacements?.length ?? 0) > 0 ||
        (preflight.removals?.length ?? 0) > 0 ||
        (preflight.providers?.length ?? 0) > 0 ||
        (preflight.import_keys?.length ?? 0) > 0 ||
        (preflight.warnings?.some((w) => w.severity !== "info") ?? false);

      if (hasIssues) {
        // Reset acknowledgments and show confirmation modal
        setAcknowledgedRemovals(false);
        setAcknowledgedConflicts(false);
        setAcknowledgedKeyImports(false);
        setAcknowledgedWarnings(new Set());
        setConfirmModalOpen(true);
        return;
      }

      // No issues - proceed directly
      startUpgrade();
    } catch (ex) {
      setPreflightLoading(false);
      setError(ex instanceof Error ? ex.message : String(ex));
      setState("error");
    }
  };

  const startUpgrade = () => {
    setConfirmModalOpen(false);
    setState("applying");
    setLog("");
    setUpgradeProgress({
      phase: "preparing",
      current: 0,
      total: selectedPackages.size,
      currentPackage: "",
      percent: 0,
    });

    const handleEvent = (event: StreamEvent) => {
      if (event.type === "download") {
        setUpgradeProgress((prev) => ({
          ...prev,
          phase: "downloading",
          currentPackage: event.filename,
          percent: event.downloaded && event.total
            ? Math.round((event.downloaded / event.total) * 100)
            : prev.percent,
        }));
      } else if (event.type === "progress") {
        const phase = event.operation.includes("hook") ? "hooks" : "installing";
        setUpgradeProgress((prev) => ({
          ...prev,
          phase,
          current: event.current,
          total: event.total,
          currentPackage: event.package,
          percent: event.percent,
        }));
      } else if (event.type === "event") {
        if (event.event.includes("hook")) {
          setUpgradeProgress((prev) => ({
            ...prev,
            phase: "hooks",
            currentPackage: event.package || "",
          }));
        }
      }
    };

    const { cancel } = runUpgrade({
      onEvent: handleEvent,
      onData: (data) => setLog((prev) => {
        const newLog = prev + data;
        return newLog.length > MAX_LOG_SIZE_BYTES ? newLog.slice(-MAX_LOG_SIZE_BYTES) : newLog;
      }),
      onComplete: () => {
        setState("success");
        setUpdates([]);
        cancelRef.current = null;
        if (rebootOnComplete) {
          rebootSystem().catch(() => loadRebootStatus());
          return;
        }
        loadRebootStatus();
        loadServicesStatus().then((status) => {
          if (restartServicesOnComplete && status?.restart_required) {
            const units = status.services
              .filter((s) => !effectiveBlock(s))
              .map((s) => s.name);
            if (units.length > 0) {
              restartServices(units).catch(() => loadServicesStatus());
            }
          }
        });
      },
      onError: (err) => {
        setState("error");
        setError(err);
        cancelRef.current = null;
      },
    }, ignoredPackages);
    cancelRef.current = cancel;
  };

  const handleCancelClick = () => {
    setCancelModalOpen(true);
  };

  const confirmCancel = () => {
    if (isCancelling) return;
    setIsCancelling(true);
    setCancelModalOpen(false);
    if (cancelRef.current) {
      cancelRef.current();
      cancelRef.current = null;
      setState("available");
      setLog("");
    }
    setIsCancelling(false);
  };

  const handlePackageClick = (pkgName: string) => {
    fetchDetails(pkgName);
  };

  // Summary totals based on selected packages
  const selectedDownloadSize = selectedUpdates.reduce((sum, u) => sum + u.download_size, 0);
  const selectedCurrentSize = selectedUpdates.reduce((sum, u) => sum + u.current_size, 0);
  const selectedNewSize = selectedUpdates.reduce((sum, u) => sum + u.new_size, 0);
  const selectedNetSize = selectedNewSize - selectedCurrentSize;

  const newsAlerts = visibleNews.map((item) => (
    <Alert
      key={item.link}
      variant="info"
      title={item.title}
      actionClose={<AlertActionCloseButton onClose={() => dismissNewsItem(item.link)} />}
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

  const newsErrorAlert = newsError ? (
    <Alert
      variant="warning"
      title="Unable to fetch Arch Linux news"
      actionClose={<AlertActionCloseButton onClose={() => setNewsError(false)} />}
      className="pf-v6-u-mb-md"
    >
      Could not retrieve the latest news from archlinux.org. Check your network connection or visit the{" "}
      <a href={ARCH_STATUS_URL} target="_blank" rel="noopener noreferrer">Arch Linux status page</a>
      {" "}for service updates.
    </Alert>
  ) : null;

  const rebootAlert = rebootStatus?.requires_reboot ? (
    <Alert
      variant="warning"
      title="System reboot recommended"
      className="pf-v6-u-mb-md"
      actionLinks={
        <Button variant="warning" icon={<PowerOffIcon />} onClick={() => rebootSystem()}>
          Reboot Now
        </Button>
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

  const isLocalCockpit = useMemo(
    () => ["localhost", "127.0.0.1", "::1", ""].includes(window.location.hostname),
    [],
  );
  const effectiveBlock = useCallback(
    (svc: ServiceRestart) =>
      svc.restart_blocked === "cockpit_transport" && isLocalCockpit
        ? undefined
        : svc.restart_blocked,
    [isLocalCockpit],
  );
  const safeServices = useMemo(
    () => servicesStatus?.services.filter((s) => !effectiveBlock(s)) ?? [],
    [servicesStatus, effectiveBlock],
  );
  const blockedServices = useMemo(
    () => servicesStatus?.services.filter((s) => effectiveBlock(s)) ?? [],
    [servicesStatus, effectiveBlock],
  );
  const servicesSignature = useMemo(
    () => (servicesStatus?.services ?? []).map((s) => s.name).sort().join(","),
    [servicesStatus],
  );
  const servicesAlert = servicesStatus?.restart_required
    && servicesSignature !== ""
    && dismissedServicesSignature !== undefined
    && dismissedServicesSignature !== servicesSignature ? (
    <Alert
      variant="warning"
      title="Running services need to be restarted"
      className="pf-v6-u-mb-md"
      actionClose={
        <AlertActionCloseButton
          onClose={() => {
            setDismissedServicesSignature(servicesSignature);
            markServicesDismissed(servicesSignature).catch((err) => {
              console.error("Failed to persist services dismissal:", err);
            });
          }}
        />
      }
      actionLinks={
        safeServices.length > 0 ? (
          <Button
            variant="warning"
            onClick={() =>
              restartServices(safeServices.map((s) => s.name))
                .then(() => loadServicesStatus())
                .catch(() => loadServicesStatus())
            }
          >
            Restart safe ({safeServices.length})
          </Button>
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
              const blk = effectiveBlock(svc);
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

  if (state === "loading" || state === "checking") {
    return (
      <Card>
        <CardBody>
          <EmptyState  headingLevel="h2" icon={Spinner}  titleText="Checking for updates">
            <EmptyStateBody>
              Querying package databases...
            </EmptyStateBody>
          </EmptyState>
        </CardBody>
      </Card>
    );
  }

  if (state === "error") {
    const isLockError = error ? /unable to lock database|failed to initialize transaction/i.test(error) : false;
    const isNetworkError = error ? /failed to retrieve|unable to connect|could not resolve|timed\s+out|timeout|dns|connection refused/i.test(error) : false;
    return (
      <Card>
        <CardBody>
          <EmptyState
            headingLevel="h2"
            icon={ExclamationCircleIcon}
            titleText={isLockError ? "Database is locked" : "Error checking for updates"}
            status={isLockError ? "warning" : "danger"}
          >
            <EmptyStateBody>
              {isLockError
                ? <LockErrorBody onRetry={loadUpdates} />
                : error}
              {isNetworkError && !isLockError && (
                <Content component={ContentVariants.p} className="pf-v6-u-mt-sm">
                  Check your network connection or visit the{" "}
                  <a href={ARCH_STATUS_URL} target="_blank" rel="noopener noreferrer">Arch Linux status page</a>
                  {" "}for service updates.
                </Content>
              )}
            </EmptyStateBody>
            <EmptyStateFooter>
              <EmptyStateActions>
                <Button variant="primary" onClick={loadUpdates}>Retry</Button>
                <Button variant="link" onClick={() => setState("uptodate")}>Dismiss</Button>
              </EmptyStateActions>
            </EmptyStateFooter>
          </EmptyState>
        </CardBody>
      </Card>
    );
  }

  if (state === "applying") {
    const phaseLabels: Record<UpgradeProgress["phase"], string> = {
      preparing: "Preparing upgrade",
      downloading: "Downloading packages",
      installing: "Upgrading packages",
      hooks: "Running post-transaction hooks",
    };

    const progressValue = upgradeProgress.total > 0
      ? Math.round((upgradeProgress.current / upgradeProgress.total) * 100)
      : undefined;

    const progressLabel = upgradeProgress.total > 0
      ? `${upgradeProgress.current} of ${upgradeProgress.total}`
      : undefined;

    return (
      <Card>
        <CardBody>
          <Flex justifyContent={{ default: "justifyContentSpaceBetween" }} alignItems={{ default: "alignItemsCenter" }}>
            <FlexItem>
              <CardTitle className="pf-v6-u-m-0">Applying Updates</CardTitle>
            </FlexItem>
            <FlexItem>
              <Button variant="danger" onClick={handleCancelClick}>
                Cancel
              </Button>
            </FlexItem>
          </Flex>

          <Content className="pf-v6-u-mt-md pf-v6-u-mb-sm">
            <strong>{phaseLabels[upgradeProgress.phase]}</strong>
            {upgradeProgress.currentPackage && (
              <span style={{ color: "var(--pf-t--global--text--color--subtle)" }}>
                {" "}- {upgradeProgress.currentPackage}
              </span>
            )}
          </Content>

          <Progress
            value={progressValue}
            title={progressLabel}
            measureLocation={progressValue !== undefined ? ProgressMeasureLocation.outside : ProgressMeasureLocation.none}
            aria-label="Upgrade progress"
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

          <ExpandableSection
            toggleText={isDetailsExpanded ? "Hide details" : "Show details"}
            onToggle={(_event, expanded) => setIsDetailsExpanded(expanded)}
            isExpanded={isDetailsExpanded}
            className="pf-v6-u-mt-md"
          >
            <div ref={logContainerRef} style={{ maxHeight: LOG_CONTAINER_HEIGHT, overflow: "auto" }}>
              <CodeBlock>
                <CodeBlockCode>{log || "Starting upgrade..."}</CodeBlockCode>
              </CodeBlock>
            </div>
          </ExpandableSection>
        </CardBody>

        <Modal
          variant={ModalVariant.small}
          isOpen={cancelModalOpen}
          onClose={() => setCancelModalOpen(false)}
        >
          <ModalHeader title="Cancel upgrade?" />
          <ModalBody>
            {upgradeProgress.phase === "downloading" || upgradeProgress.phase === "preparing" ? (
              <Content>
                <Content component={ContentVariants.p}>
                  The upgrade has not started modifying your system yet. It is safe to cancel now.
                </Content>
              </Content>
            ) : (
              <Content>
                <Content component={ContentVariants.p}>
                  <strong>Warning:</strong> The upgrade is currently {upgradeProgress.phase === "hooks" ? "running post-transaction hooks" : "installing packages"}.
                </Content>
                <Content component={ContentVariants.p}>
                  Cancelling now may leave your system in an inconsistent state. You may need to run <code>pacman -Syu</code> manually to complete the upgrade.
                </Content>
              </Content>
            )}
          </ModalBody>
          <ModalFooter>
            <Button key="cancel-confirm" variant="danger" onClick={confirmCancel} isDisabled={isCancelling} isLoading={isCancelling}>
              {upgradeProgress.phase === "downloading" || upgradeProgress.phase === "preparing"
                ? "Cancel Upgrade"
                : "Cancel Anyway"}
            </Button>
            <Button key="cancel-dismiss" variant="link" onClick={() => setCancelModalOpen(false)} isDisabled={isCancelling}>
              Continue Upgrade
            </Button>
          </ModalFooter>
        </Modal>
      </Card>
    );
  }

  if (state === "success") {
    return (
      <Card>
        <CardBody>
          {rebootAlert}
          {servicesAlert}
          <EmptyState  headingLevel="h2" icon={CheckCircleIcon}  titleText="System Updated">
            <EmptyStateBody>
              All packages have been updated successfully.
            </EmptyStateBody>
            <EmptyStateFooter>
              <EmptyStateActions>
                <Button variant="primary" onClick={loadUpdates}>
                  Check Again
                </Button>
              </EmptyStateActions>
            </EmptyStateFooter>
          </EmptyState>
          {log && (
            <div className="pf-v6-u-mt-md" style={{ maxHeight: LOG_CONTAINER_HEIGHT, overflow: "auto" }}>
              <CodeBlock>
                <CodeBlockCode>{log}</CodeBlockCode>
              </CodeBlock>
            </div>
          )}
        </CardBody>
      </Card>
    );
  }

  if (state === "uptodate") {
    return (
      <>
        {rebootAlert}
        {servicesAlert}
        {warnings.length > 0 && (
          <Alert variant="warning" title="Warnings" className="pf-v6-u-mb-md">
            <ul className="pf-v6-u-m-0 pf-v6-u-pl-lg">
              {warnings.map((w) => <li key={w}>{w}</li>)}
            </ul>
          </Alert>
        )}
        {newsErrorAlert}
        {newsAlerts}
        {keyringStatus && !keyringStatus.master_key_initialized && (
          <Alert variant="warning" title="Keyring not initialized" isInline className="pf-v6-u-mb-md">
            The pacman keyring is not initialized. Package signature verification may fail.
          </Alert>
        )}
        {keyringStatus?.warnings.map((w) => (
          <Alert key={w} variant="warning" title={w} isInline className="pf-v6-u-mb-md" />
        ))}

        <SystemOverviewCard
          updates={updates}
          securityCount={securityUpdateCount}
          securityLoading={securityLoading}
          orphanCount={orphanCount}
          cacheSize={cacheSize}
          keyringStatus={keyringStatus}
          summaryLoading={summaryLoading}
          pendingSignoffs={pendingSignoffs}
        />

        <Card className="pf-v6-u-mb-md">
          <CardBody style={{ paddingBottom: 0 }}>
            <Toolbar>
              <ToolbarContent>
                <ToolbarItem>
                  <Button
                    variant="secondary"
                    onClick={() => setScheduleModalOpen(true)}
                  >
                    Manage Schedule
                  </Button>
                </ToolbarItem>
                <ToolbarItem>
                  <Button
                    variant="secondary"
                    onClick={() => setIgnoredModalOpen(true)}
                  >
                    Manage Ignored{ignoredCount > 0 ? ` (${ignoredCount})` : ""}
                  </Button>
                </ToolbarItem>
                <ToolbarItem>
                  <Button
                    variant="secondary"
                    icon={<SyncAltIcon />}
                    onClick={handleRefresh}
                  >
                    Refresh
                  </Button>
                </ToolbarItem>
              </ToolbarContent>
            </Toolbar>
          </CardBody>
        </Card>

        <Card>
          <CardBody>
            <EmptyState  headingLevel="h2" icon={CheckCircleIcon}  titleText="System is up to date">
              <EmptyStateBody>
                All installed packages are at their latest versions.
              </EmptyStateBody>
            </EmptyState>
          </CardBody>
        </Card>

        <IgnoredPackagesModal
          isOpen={ignoredModalOpen}
          onClose={() => setIgnoredModalOpen(false)}
          onIgnoredChange={() => loadUpdates()}
        />
        <ScheduleModal
          isOpen={scheduleModalOpen}
          onClose={() => setScheduleModalOpen(false)}
        />
      </>
    );
  }

  return (
    <>
      {rebootAlert}
      {servicesAlert}
      {warnings.length > 0 && (
        <Alert variant="warning" title="Warnings" className="pf-v6-u-mb-md">
          <ul className="pf-v6-u-m-0 pf-v6-u-pl-lg">
            {warnings.map((w) => <li key={w}>{w}</li>)}
          </ul>
        </Alert>
      )}
      {newsErrorAlert}
      {newsAlerts}
      {keyringStatus && !keyringStatus.master_key_initialized && (
        <Alert variant="warning" title="Keyring not initialized" isInline className="pf-v6-u-mb-md">
          The pacman keyring is not initialized. Package signature verification may fail.
        </Alert>
      )}
      {keyringStatus?.warnings.map((w) => (
        <Alert key={w} variant="warning" title={w} isInline className="pf-v6-u-mb-md" />
      ))}
      {ignoredPackages.length > 0 && (
        <Alert variant="warning" title="Partial upgrade" isInline className="pf-v6-u-mb-md">
          Skipping {ignoredPackages.length} package{ignoredPackages.length !== 1 ? "s" : ""}. Partial upgrades are unsupported and may cause dependency issues.
        </Alert>
      )}

      <SystemOverviewCard
        updates={updates}
        securityCount={securityUpdateCount}
        securityLoading={securityLoading}
        orphanCount={orphanCount}
        cacheSize={cacheSize}
        keyringStatus={keyringStatus}
        summaryLoading={summaryLoading}
        pendingSignoffs={pendingSignoffs}
      />

      <Card>
        <CardBody>
          <CardTitle className="pf-v6-u-m-0 pf-v6-u-mb-md">
            {formatNumber(selectedPackages.size)} of {formatNumber(updates.length)} update{updates.length !== 1 ? "s" : ""} selected
            {filteredUpdates.length !== updates.length && ` (${formatNumber(filteredUpdates.length)} shown)`}
          </CardTitle>
          <Flex spaceItems={{ default: "spaceItemsLg" }} className="pf-v6-u-mb-md">
            <FlexItem>
              <StatBox
                label="Download Size"
                value={formatSize(selectedDownloadSize)}
                color="info"
              />
            </FlexItem>
            <FlexItem>
              <StatBox
                label="Installed Size"
                value={formatSize(selectedNewSize)}
              />
            </FlexItem>
            <FlexItem>
              <StatBox
                label="Net Size"
                value={`${selectedNetSize >= 0 ? "+" : ""}${formatSize(selectedNetSize)}`}
                color={selectedNetSize > 0 ? "danger" : selectedNetSize < 0 ? "success" : "default"}
              />
            </FlexItem>
          </Flex>
          <Toolbar className="pf-v6-u-px-0">
            <ToolbarContent>
              <ToolbarItem>
                <SearchInput
                  placeholder="Filter updates..."
                  value={searchFilter}
                  onChange={(_event: React.SyntheticEvent, value: string) => setSearchFilter(value)}
                  onClear={() => setSearchFilter("")}
                  aria-label="Filter updates"
                />
              </ToolbarItem>
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
                <Button
                  variant="secondary"
                  onClick={() => setScheduleModalOpen(true)}
                >
                  Manage Schedule
                </Button>
              </ToolbarItem>
              <ToolbarItem>
                <Button
                  variant="secondary"
                  onClick={() => setIgnoredModalOpen(true)}
                >
                  Manage Ignored{ignoredCount > 0 ? ` (${ignoredCount})` : ""}
                </Button>
              </ToolbarItem>
              <ToolbarItem>
                <Button
                  variant="secondary"
                  icon={<SyncAltIcon />}
                  onClick={handleRefresh}
                >
                  Refresh
                </Button>
              </ToolbarItem>
              <ToolbarItem>
                <Button
                  variant="primary"
                  onClick={handleApplyUpdates}
                  isLoading={preflightLoading}
                  isDisabled={preflightLoading || selectedPackages.size === 0}
                >
                  {preflightLoading ? "Checking..." : `Apply ${formatNumber(selectedPackages.size)} Update${selectedPackages.size !== 1 ? "s" : ""}`}
                </Button>
              </ToolbarItem>
            </ToolbarContent>
          </Toolbar>

        <Table aria-label="Available updates" variant="compact">
          <Thead>
            <Tr>
              <Th screenReaderText="Select">
                <Checkbox
                  id="select-all-updates"
                  isChecked={areAllSelected}
                  onChange={(_event, checked) => checked ? selectAllPackages() : deselectAllPackages()}
                  aria-label="Select all updates"
                />
              </Th>
              <Th sort={getSortParams("name")}>Package</Th>
              <Th sort={getSortParams("repo")}>Repository</Th>
              <Th>Version</Th>
              <Th sort={getSortParams("download")}>Download</Th>
              <Th sort={getSortParams("installed")}>Installed</Th>
              <Th sort={getSortParams("net")}>Net{" "}<Tooltip content="Change in installed size after this update. Green (down) means the package shrinks, red (up) means it grows."><Icon isInline style={{ cursor: "pointer" }} onClick={(e: React.MouseEvent) => e.stopPropagation()}><OutlinedQuestionCircleIcon /></Icon></Tooltip></Th>
              <Th screenReaderText="Actions" />
            </Tr>
          </Thead>
          <Tbody>
            {sortedUpdates.map((update) => {
              const netSize = update.new_size - update.current_size;
              const isSelected = selectedPackages.has(update.name);
              const isIgnored = update.ignored;
              const advisories = securityMap.get(update.name);
              const hasAdvisories = advisories && advisories.length > 0;
              const highest = hasAdvisories
                ? advisories.reduce((a, b) =>
                    (SEVERITY_ORDER[b.severity] ?? 0) > (SEVERITY_ORDER[a.severity] ?? 0) ? b : a
                  )
                : null;
              const borderColor = highest
                ? `var(--pf-t--global--color--status--${highest.severity === "Critical" || highest.severity === "High" ? "danger" : "warning"}--default)`
                : undefined;
              return (
                <Tr
                  key={update.name}
                  isClickable
                  onRowClick={() => handlePackageClick(update.name)}
                  isRowSelected={isSelected}
                  style={borderColor ? { borderLeft: `3px solid ${borderColor}` } : undefined}
                >
                  <Td
                    select={{
                      rowIndex: 0,
                      onSelect: (_event, _isSelected) => togglePackageSelection(update.name),
                      isSelected,
                      isDisabled: isIgnored,
                    }}
                    onClick={(e) => e.stopPropagation()}
                  />
                  <Td dataLabel="Package">
                    <Button variant="link" isInline className="pf-v6-u-p-0">
                      {update.name}
                    </Button>
                    {isIgnored && (
                      <Label
                        color="orange"
                        className="pf-v6-u-ml-sm"
                        isCompact
                        onClick={(e: React.MouseEvent) => {
                          e.stopPropagation();
                          setIgnoredModalOpen(true);
                        }}
                        style={{ cursor: "pointer" }}
                      >
                        ignored
                      </Label>
                    )}
                    {hasAdvisories && highest && (
                      <Popover
                        headerContent={<>{advisories.length} securit{advisories.length === 1 ? "y advisory" : "y advisories"}</>}
                        bodyContent={
                          <div>
                            {advisories.map((a) => (
                              <div key={a.avg_name} style={{ marginBottom: "0.5rem" }}>
                                <a
                                  href={`https://security.archlinux.org/${a.avg_name}`}
                                  target="_blank"
                                  rel="noopener noreferrer"
                                >
                                  {a.avg_name}
                                </a>
                                {" "}<Label isCompact color={severityColor(a.severity)}>{a.severity}</Label>
                                <div style={{ color: "var(--pf-t--global--text--color--subtle)", fontSize: "0.85em" }}>
                                  {a.advisory_type}
                                  {a.cve_ids.length > 0 && ` (${a.cve_ids.join(", ")})`}
                                </div>
                              </div>
                            ))}
                          </div>
                        }
                      >
                        <Label
                          isCompact
                          color={severityColor(highest.severity)}
                          icon={<ShieldAltIcon />}
                          className="pf-v6-u-ml-sm"
                          style={{ cursor: "pointer" }}
                          onClick={(e) => e.stopPropagation()}
                        >
                          {highest.severity}
                          {advisories.length > 1 && ` +${advisories.length - 1}`}
                        </Label>
                      </Popover>
                    )}
                  </Td>
                  <Td dataLabel="Repository">
                    <Label isCompact color="grey">{update.repository}</Label>
                  </Td>
                  <Td dataLabel="Version">{update.current_version} {"\u2192"} {update.new_version}</Td>
                  <Td dataLabel="Download">{formatSize(update.download_size)}</Td>
                  <Td dataLabel="Installed Size">{formatSize(update.new_size)}</Td>
                  <Td dataLabel="Net" style={{ color: netSize > 0 ? "var(--pf-t--global--color--status--danger--default)" : netSize < 0 ? "var(--pf-t--global--color--status--success--default)" : undefined }}>
                    {netSize > 0 && <ArrowUpIcon style={{ marginRight: "0.25rem" }} />}
                    {netSize < 0 && <ArrowDownIcon style={{ marginRight: "0.25rem" }} />}
                    {netSize >= 0 ? "+" : ""}{formatSize(netSize)}
                  </Td>
                  <Td
                    isActionCell
                    onClick={(e) => e.stopPropagation()}
                  >
                    {!isIgnored && (
                      <Dropdown
                        isOpen={openKebab === update.name}
                        onOpenChange={(open: boolean) => setOpenKebab(open ? update.name : null)}
                        onSelect={() => setOpenKebab(null)}
                        popperProps={{ position: "right" }}
                        toggle={(toggleRef: React.Ref<MenuToggleElement>) => (
                          <MenuToggle
                            ref={toggleRef}
                            variant="plain"
                            aria-label={`Actions for ${update.name}`}
                            isExpanded={openKebab === update.name}
                            onClick={() => setOpenKebab(openKebab === update.name ? null : update.name)}
                          >
                            <EllipsisVIcon />
                          </MenuToggle>
                        )}
                      >
                        <DropdownList>
                          <DropdownItem
                            onClick={async () => {
                              try {
                                await addIgnoredPackage(update.name);
                                await loadUpdates();
                              } catch (err) {
                                console.error("Failed to ignore package:", err);
                              }
                            }}
                          >
                            Ignore package
                          </DropdownItem>
                        </DropdownList>
                      </Dropdown>
                    )}
                  </Td>
                </Tr>
              );
            })}
          </Tbody>
        </Table>
        </CardBody>
      </Card>

      <PackageDetailsModal
        packageDetails={selectedPackage}
        isLoading={packageLoading}
        onClose={clearDetails}
        error={detailsError}
        onViewDependencies={onViewDependencies}
        onViewHistory={onViewHistory}
        onPackageRemoved={loadUpdates}
        isIgnored={selectedPackage ? ignoredNameSet.has(selectedPackage.name) : false}
        onIgnored={loadUpdates}
      />

      <Modal
        variant={ModalVariant.medium}
        isOpen={confirmModalOpen}
        onClose={() => setConfirmModalOpen(false)}
      >
        <ModalHeader title="Confirm Upgrade" />
        <ModalBody>
          {preflightData && (
            <Content>
              <Content component={ContentVariants.p}>
                The following actions will be performed during this upgrade:
              </Content>

              {(preflightData.removals?.length ?? 0) > 0 && (
                <Alert variant="danger" title="Packages will be removed" isInline className="pf-v6-u-mt-md">
                  <Content component={ContentVariants.p}>
                    The following packages will be removed to resolve dependencies:
                  </Content>
                  <List>
                    {preflightData.removals!.map((pkg) => (
                      <ListItem key={pkg}>{pkg}</ListItem>
                    ))}
                  </List>
                  <Checkbox
                    id="acknowledge-removals"
                    label="I understand these packages will be removed"
                    isChecked={acknowledgedRemovals}
                    onChange={(_event, checked) => setAcknowledgedRemovals(checked)}
                    className="pf-v6-u-mt-sm"
                  />
                </Alert>
              )}

              {(preflightData.conflicts?.length ?? 0) > 0 && (
                <Alert variant="warning" title="Package conflicts detected" isInline className="pf-v6-u-mt-md">
                  <Content component={ContentVariants.p}>
                    The following conflicts will be resolved automatically:
                  </Content>
                  <List>
                    {preflightData.conflicts!.map((c) => (
                      <ListItem key={`${c.package1}-${c.package2}`}>
                        {c.package1} conflicts with {c.package2}
                      </ListItem>
                    ))}
                  </List>
                  <Checkbox
                    id="acknowledge-conflicts"
                    label="I understand conflicts will be resolved automatically"
                    isChecked={acknowledgedConflicts}
                    onChange={(_event, checked) => setAcknowledgedConflicts(checked)}
                    className="pf-v6-u-mt-sm"
                  />
                </Alert>
              )}

              {(preflightData.import_keys?.length ?? 0) > 0 && (
                <Alert variant="warning" title="PGP keys will be imported" isInline className="pf-v6-u-mt-md">
                  <Content component={ContentVariants.p}>
                    The following keys will be imported to verify package signatures:
                  </Content>
                  <List>
                    {preflightData.import_keys!.map((k) => (
                      <ListItem key={k.fingerprint}>
                        {k.uid} ({k.fingerprint})
                      </ListItem>
                    ))}
                  </List>
                  <Checkbox
                    id="acknowledge-key-imports"
                    label="I trust these keys and want to import them"
                    isChecked={acknowledgedKeyImports}
                    onChange={(_event, checked) => setAcknowledgedKeyImports(checked)}
                    className="pf-v6-u-mt-sm"
                  />
                </Alert>
              )}

              {preflightData.warnings?.map((w) => (
                <Alert
                  key={w.id}
                  variant={w.severity === "danger" ? "danger" : w.severity === "info" ? "info" : "warning"}
                  title={w.title}
                  isInline
                  className="pf-v6-u-mt-md"
                >
                  <Content component={ContentVariants.p}>{w.message}</Content>
                  {w.packages.length > 0 && (
                    <List>
                      {w.packages.map((pkg) => (
                        <ListItem key={`${w.id}-${pkg}`}>{pkg}</ListItem>
                      ))}
                    </List>
                  )}
                  {(w.severity === "warning" || w.severity === "danger") && (
                    <Checkbox
                      id={`acknowledge-warning-${w.id}`}
                      label="I understand and want to proceed"
                      isChecked={acknowledgedWarnings.has(w.id)}
                      onChange={(_event, checked) => {
                        setAcknowledgedWarnings((prev) => {
                          const next = new Set(prev);
                          if (checked) {
                            next.add(w.id);
                          } else {
                            next.delete(w.id);
                          }
                          return next;
                        });
                      }}
                      className="pf-v6-u-mt-sm"
                    />
                  )}
                </Alert>
              ))}

              {(preflightData.replacements?.length ?? 0) > 0 && (
                <Alert variant="info" title="Package replacements" isInline className="pf-v6-u-mt-md">
                  <Content component={ContentVariants.p}>
                    The following packages will be replaced:
                  </Content>
                  <List>
                    {preflightData.replacements!.map((r) => (
                      <ListItem key={`${r.old_package}-${r.new_package}`}>
                        {r.old_package} will be replaced by {r.new_package}
                      </ListItem>
                    ))}
                  </List>
                </Alert>
              )}

              {(preflightData.providers?.length ?? 0) > 0 && (
                <Alert variant="info" title="Provider selections" isInline className="pf-v6-u-mt-md">
                  <Content component={ContentVariants.p}>
                    The first available provider will be selected for the following dependencies:
                  </Content>
                  <List>
                    {preflightData.providers!.map((p) => (
                      <ListItem key={p.dependency}>
                        {p.dependency}: {p.providers[0]} (from: {p.providers.join(", ")})
                      </ListItem>
                    ))}
                  </List>
                </Alert>
              )}

              <Content component={ContentVariants.p} className="pf-v6-u-mt-md">
                <strong>{preflightData.packages_to_upgrade}</strong> packages will be upgraded
                (download: {formatSize(preflightData.total_download_size)})
              </Content>
            </Content>
          )}
        </ModalBody>
        <ModalFooter>
          <Button
            key="confirm"
            variant={(preflightData?.removals?.length ?? 0) > 0 || (preflightData?.conflicts?.length ?? 0) > 0 ? "danger" : "primary"}
            onClick={startUpgrade}
            isDisabled={!allDangerousActionsAcknowledged}
          >
            Proceed with Upgrade
          </Button>
          <Button key="cancel" variant="link" onClick={() => setConfirmModalOpen(false)}>
            Cancel
          </Button>
        </ModalFooter>
      </Modal>

      <IgnoredPackagesModal
        isOpen={ignoredModalOpen}
        onClose={() => setIgnoredModalOpen(false)}
        onIgnoredChange={() => loadUpdates()}
      />

      <ScheduleModal
        isOpen={scheduleModalOpen}
        onClose={() => setScheduleModalOpen(false)}
      />
    </>
  );
};
