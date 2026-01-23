import React, { useState, useEffect, useCallback, useRef, useMemo } from "react";
import { LOG_CONTAINER_HEIGHT, MAX_LOG_SIZE_BYTES } from "../constants";
import { useSortableTable } from "../hooks/useSortableTable";
import { useAutoScrollLog } from "../hooks/useAutoScrollLog";
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
} from '@patternfly/react-core';
import {
  CheckCircleIcon,
  SyncAltIcon,
  ArrowUpIcon,
  ArrowDownIcon,
} from "@patternfly/react-icons";
import { Table, Thead, Tr, Th, Tbody, Td } from "@patternfly/react-table";
import {
  UpdateInfo,
  SyncPackageDetails,
  PreflightResponse,
  StreamEvent,
  RebootStatus,
  KeyringStatusResponse,
  checkUpdates,
  runUpgrade,
  syncDatabase,
  getSyncPackageInfo,
  preflightUpgrade,
  formatSize,
  formatNumber,
  listIgnoredPackages,
  getRebootStatus,
  listOrphans,
  getCacheInfo,
  getKeyringStatus,
} from "../api";

import { PackageDetailsModal } from "./PackageDetailsModal";
import { StatBox } from "./StatBox";
import { IgnoredPackagesModal } from "./IgnoredPackagesModal";
import { ScheduleModal } from "./ScheduleModal";

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

interface UpdatesViewProps {
  onViewDependencies?: (packageName: string) => void;
}

export const UpdatesView: React.FC<UpdatesViewProps> = ({ onViewDependencies }) => {
  const [state, setState] = useState<ViewState>("loading");
  const [updates, setUpdates] = useState<UpdateInfo[]>([]);
  const [log, setLog] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [warnings, setWarnings] = useState<string[]>([]);
  const cancelRef = useRef<(() => void) | null>(null);
  const logContainerRef = useAutoScrollLog(log);
  const [selectedPackage, setSelectedPackage] = useState<SyncPackageDetails | null>(null);
  const [packageLoading, setPackageLoading] = useState(false);
  const [searchFilter, setSearchFilter] = useState("");
  const [repoFilter, setRepoFilter] = useState("all");
  const [repoSelectOpen, setRepoSelectOpen] = useState(false);
  const [confirmModalOpen, setConfirmModalOpen] = useState(false);
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
  const [isCancelling, setIsCancelling] = useState(false);
  const [configIgnored, setConfigIgnored] = useState<Set<string>>(new Set());
  const [ignoredModalOpen, setIgnoredModalOpen] = useState(false);
  const [scheduleModalOpen, setScheduleModalOpen] = useState(false);
  const [acknowledgedRemovals, setAcknowledgedRemovals] = useState(false);
  const [acknowledgedConflicts, setAcknowledgedConflicts] = useState(false);
  const [acknowledgedKeyImports, setAcknowledgedKeyImports] = useState(false);
  const [rebootStatus, setRebootStatus] = useState<RebootStatus | null>(null);
  const [orphanCount, setOrphanCount] = useState<number | null>(null);
  const [cacheSize, setCacheSize] = useState<number | null>(null);
  const [keyringStatus, setKeyringStatus] = useState<KeyringStatusResponse | null>(null);
  const [summaryLoading, setSummaryLoading] = useState(true);

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

  // Check if all required acknowledgments are made for dangerous operations
  const allDangerousActionsAcknowledged = useMemo(() => {
    if (!preflightData) return true;
    const needsRemovalAck = (preflightData.removals?.length ?? 0) > 0;
    const needsConflictAck = (preflightData.conflicts?.length ?? 0) > 0;
    const needsKeyImportAck = (preflightData.import_keys?.length ?? 0) > 0;
    return (
      (!needsRemovalAck || acknowledgedRemovals) &&
      (!needsConflictAck || acknowledgedConflicts) &&
      (!needsKeyImportAck || acknowledgedKeyImports)
    );
  }, [preflightData, acknowledgedRemovals, acknowledgedConflicts, acknowledgedKeyImports]);

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
    setSelectedPackages(new Set(updates.map((u) => u.name)));
  };

  const deselectAllPackages = () => {
    setSelectedPackages(new Set());
  };

  const areAllSelected = selectedPackages.size === updates.length && updates.length > 0;
  const areSomeSelected = selectedPackages.size > 0 && selectedPackages.size < updates.length;

  const loadUpdates = useCallback(async () => {
    setState("checking");
    setError(null);
    setWarnings([]);
    try {
      const response = await checkUpdates();
      setUpdates(response.updates);
      setWarnings(response.warnings);
      setState(response.updates.length > 0 ? "available" : "uptodate");
    } catch (ex) {
      setState("error");
      setError(ex instanceof Error ? ex.message : String(ex));
    }
  }, []);

  useEffect(() => {
    loadUpdates();
  }, [loadUpdates]);

  const loadConfigIgnored = useCallback(async () => {
    try {
      const response = await listIgnoredPackages();
      setConfigIgnored(new Set(response.packages));
    } catch (err) {
      console.error("Failed to load ignored packages:", err);
    }
  }, []);

  useEffect(() => {
    loadConfigIgnored();
  }, [loadConfigIgnored]);

  const loadRebootStatus = useCallback(async () => {
    try {
      const status = await getRebootStatus();
      setRebootStatus(status);
    } catch {
      setRebootStatus(null);
    }
  }, []);

  useEffect(() => {
    loadRebootStatus();
  }, [loadRebootStatus]);

  const loadSummary = useCallback(async () => {
    setSummaryLoading(true);
    const [orphans, cache, keyring] = await Promise.all([
      listOrphans().catch(() => null),
      getCacheInfo().catch(() => null),
      getKeyringStatus().catch(() => null),
    ]);
    setOrphanCount(orphans?.orphans.length ?? null);
    setCacheSize(cache?.total_size ?? null);
    setKeyringStatus(keyring);
    setSummaryLoading(false);
  }, []);

  useEffect(() => {
    loadSummary();
  }, [loadSummary]);

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
      // Preserve selections, only remove packages that no longer exist
      setSelectedPackages((prev) => {
        const existingNames = new Set(updates.map((u) => u.name));
        const next = new Set<string>();
        for (const pkg of prev) {
          if (existingNames.has(pkg) && !configIgnored.has(pkg)) {
            next.add(pkg);
          }
        }
        return next;
      });
      return;
    }

    // First load: select all non-ignored
    const nonIgnored = updates
      .filter((u) => !configIgnored.has(u.name))
      .map((u) => u.name);
    setSelectedPackages(new Set(nonIgnored));
    hasInitializedSelection.current = true;
  }, [updates, configIgnored]);

  useEffect(() => {
    return () => {
      if (cancelRef.current) {
        cancelRef.current();
      }
    };
  }, []);


  const handleRefresh = async () => {
    setState("checking");
    setLog("");
    setSelectedPackages(new Set());
    syncDatabase({
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
        (preflight.import_keys?.length ?? 0) > 0;

      if (hasIssues) {
        // Reset acknowledgments and show confirmation modal
        setAcknowledgedRemovals(false);
        setAcknowledgedConflicts(false);
        setAcknowledgedKeyImports(false);
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
        loadRebootStatus();
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

  const handlePackageClick = async (pkgName: string) => {
    setPackageLoading(true);
    try {
      const details = await getSyncPackageInfo(pkgName);
      setSelectedPackage(details);
    } catch (ex) {
      console.error("Failed to load package details:", ex);
    } finally {
      setPackageLoading(false);
    }
  };

  const handleCloseModal = () => {
    setSelectedPackage(null);
  };

  // Summary totals based on selected packages
  const selectedDownloadSize = selectedUpdates.reduce((sum, u) => sum + u.download_size, 0);
  const selectedCurrentSize = selectedUpdates.reduce((sum, u) => sum + u.current_size, 0);
  const selectedNewSize = selectedUpdates.reduce((sum, u) => sum + u.new_size, 0);
  const selectedNetSize = selectedNewSize - selectedCurrentSize;

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
    const isLockError = error?.toLowerCase().includes("unable to lock database");
    return (
      <Card>
        <CardBody>
          <Alert
            variant={isLockError ? "warning" : "danger"}
            title={isLockError ? "Database is locked" : "Error checking for updates"}
            actionClose={<AlertActionCloseButton onClose={() => setState("uptodate")} />}
          >
            {isLockError
              ? "Another package manager operation is in progress. This could be a system upgrade, package installation, or database sync. Please wait for it to complete before checking for updates."
              : error}
          </Alert>
          <div className="pf-v6-u-mt-md">
            <Button variant="primary" onClick={loadUpdates}>
              Retry
            </Button>
          </div>
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
          {rebootStatus?.requires_reboot && (
            <Alert
              variant="warning"
              title="System reboot recommended"
              className="pf-v6-u-mb-md"
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
          )}
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
      <Card>
        <CardBody>
          {rebootStatus?.requires_reboot && (
            <Alert
              variant="warning"
              title="System reboot recommended"
              className="pf-v6-u-mb-md"
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
          )}
          {warnings.length > 0 && (
            <Alert variant="warning" title="Warnings" className="pf-v6-u-mb-md">
              <ul className="pf-v6-u-m-0 pf-v6-u-pl-lg">
                {warnings.map((w, i) => <li key={i}>{w}</li>)}
              </ul>
            </Alert>
          )}
          <EmptyState  headingLevel="h2" icon={CheckCircleIcon}  titleText="System is up to date">
            <EmptyStateBody>
              All installed packages are at their latest versions.
            </EmptyStateBody>
            <EmptyStateFooter>
              <EmptyStateActions>
                <Button
                  variant="secondary"
                  icon={<SyncAltIcon />}
                  onClick={handleRefresh}
                >
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
    <>
      {rebootStatus?.requires_reboot && (
        <Alert
          variant="warning"
          title="System reboot recommended"
          className="pf-v6-u-mb-md"
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
      )}
      {warnings.length > 0 && (
        <Alert variant="warning" title="Warnings" className="pf-v6-u-mb-md">
          <ul className="pf-v6-u-m-0 pf-v6-u-pl-lg">
            {warnings.map((w, i) => <li key={i}>{w}</li>)}
          </ul>
        </Alert>
      )}
      {keyringStatus && !keyringStatus.master_key_initialized && (
        <Alert variant="warning" title="Keyring not initialized" isInline className="pf-v6-u-mb-md">
          The pacman keyring is not initialized. Package signature verification may fail.
        </Alert>
      )}
      {keyringStatus?.warnings.map((w, i) => (
        <Alert key={i} variant="warning" title={w} isInline className="pf-v6-u-mb-md" />
      ))}
      {ignoredPackages.length > 0 && (
        <Alert variant="warning" title="Partial upgrade" isInline className="pf-v6-u-mb-md">
          Skipping {ignoredPackages.length} package{ignoredPackages.length !== 1 ? "s" : ""}. Partial upgrades are unsupported and may cause dependency issues.
        </Alert>
      )}

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
                label="Orphans"
                value={orphanCount !== null ? formatNumber(orphanCount) : "-"}
                color={orphanCount && orphanCount > 0 ? "warning" : "default"}
                isLoading={summaryLoading}
              />
            </FlexItem>
            <FlexItem>
              <StatBox
                label="Cache"
                value={cacheSize !== null ? formatSize(cacheSize) : "-"}
                isLoading={summaryLoading}
              />
            </FlexItem>
            <FlexItem>
              <StatBox
                label="Keyring"
                value={keyringStatus ? `${keyringStatus.total} keys` : "-"}
                color={keyringStatus?.warnings.length ? "warning" : "default"}
                isLoading={summaryLoading}
              />
            </FlexItem>
          </Flex>
        </CardBody>
      </Card>

      <Card>
        <CardBody>
          <Flex justifyContent={{ default: "justifyContentSpaceBetween" }} alignItems={{ default: "alignItemsFlexStart" }}>
            <FlexItem>
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
            </FlexItem>
            <FlexItem>
              <Button
                variant="secondary"
                onClick={() => setScheduleModalOpen(true)}
                className="pf-v6-u-mr-sm"
              >
                Manage Schedule
              </Button>
              <Button
                variant="secondary"
                onClick={() => setIgnoredModalOpen(true)}
                className="pf-v6-u-mr-sm"
              >
                Manage Ignored{configIgnored.size > 0 ? ` (${configIgnored.size})` : ""}
              </Button>
              <Button
                variant="secondary"
                icon={<SyncAltIcon />}
                onClick={handleRefresh}
                className="pf-v6-u-mr-sm"
              >
                Refresh
              </Button>
              <Button
                variant="primary"
                onClick={handleApplyUpdates}
                isLoading={preflightLoading}
                isDisabled={preflightLoading || selectedPackages.size === 0}
              >
                {preflightLoading ? "Checking..." : `Apply ${formatNumber(selectedPackages.size)} Update${selectedPackages.size !== 1 ? "s" : ""}`}
              </Button>
            </FlexItem>
          </Flex>

          <Toolbar className="pf-v6-u-px-0">
          <ToolbarContent>
            <ToolbarItem >
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
          </ToolbarContent>
        </Toolbar>

        <Table aria-label="Available updates" variant="compact">
          <Thead>
            <Tr>
              <Th screenReaderText="Select">
                <Checkbox
                  id="select-all-updates"
                  isChecked={areAllSelected ? true : areSomeSelected ? null : false}
                  onChange={(_event, checked) => checked ? selectAllPackages() : deselectAllPackages()}
                  aria-label="Select all updates"
                />
              </Th>
              <Th sort={getSortParams("name")}>Package</Th>
              <Th sort={getSortParams("repo")}>Repository</Th>
              <Th>Version</Th>
              <Th sort={getSortParams("download")}>Download</Th>
              <Th sort={getSortParams("installed")}>Installed</Th>
              <Th sort={getSortParams("net")}>Net</Th>
            </Tr>
          </Thead>
          <Tbody>
            {sortedUpdates.map((update) => {
              const netSize = update.new_size - update.current_size;
              const isSelected = selectedPackages.has(update.name);
              const isConfigIgnored = configIgnored.has(update.name);
              return (
                <Tr
                  key={update.name}
                  isClickable
                  onRowClick={() => handlePackageClick(update.name)}
                  isRowSelected={isSelected}
                >
                  <Td
                    select={{
                      rowIndex: 0,
                      onSelect: (_event, _isSelected) => togglePackageSelection(update.name),
                      isSelected,
                    }}
                    onClick={(e) => e.stopPropagation()}
                  />
                  <Td dataLabel="Package">
                    <Button variant="link" isInline className="pf-v6-u-p-0">
                      {update.name}
                    </Button>
                    {isConfigIgnored && (
                      <Label color="orange" className="pf-v6-u-ml-sm" isCompact>
                        ignored
                      </Label>
                    )}
                  </Td>
                  <Td dataLabel="Repository">
                    <Label color="blue">{update.repository}</Label>
                  </Td>
                  <Td dataLabel="Version">{update.current_version} {"\u2192"} {update.new_version}</Td>
                  <Td dataLabel="Download">{formatSize(update.download_size)}</Td>
                  <Td dataLabel="Installed Size">{formatSize(update.new_size)}</Td>
                  <Td dataLabel="Net" style={{ color: netSize > 0 ? "var(--pf-t--global--color--status--danger--default)" : netSize < 0 ? "var(--pf-t--global--color--status--success--default)" : undefined }}>
                    {netSize > 0 && <ArrowUpIcon style={{ marginRight: "0.25rem" }} />}
                    {netSize < 0 && <ArrowDownIcon style={{ marginRight: "0.25rem" }} />}
                    {netSize >= 0 ? "+" : ""}{formatSize(netSize)}
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
        onClose={handleCloseModal}
        onViewDependencies={onViewDependencies}
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
                    {preflightData.removals!.map((pkg, i) => (
                      <ListItem key={i}>{pkg}</ListItem>
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
                    {preflightData.conflicts!.map((c, i) => (
                      <ListItem key={i}>
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
                    {preflightData.import_keys!.map((k, i) => (
                      <ListItem key={i}>
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

              {(preflightData.replacements?.length ?? 0) > 0 && (
                <Alert variant="info" title="Package replacements" isInline className="pf-v6-u-mt-md">
                  <Content component={ContentVariants.p}>
                    The following packages will be replaced:
                  </Content>
                  <List>
                    {preflightData.replacements!.map((r, i) => (
                      <ListItem key={i}>
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
                    {preflightData.providers!.map((p, i) => (
                      <ListItem key={i}>
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
            variant="primary"
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
        onIgnoredChange={() => loadConfigIgnored()}
      />

      <ScheduleModal
        isOpen={scheduleModalOpen}
        onClose={() => setScheduleModalOpen(false)}
      />
    </>
  );
};
