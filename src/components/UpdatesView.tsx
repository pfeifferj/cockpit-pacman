import React, { useState, useEffect, useCallback, useRef, useMemo } from "react";
import { LOG_CONTAINER_HEIGHT, MAX_LOG_SIZE_BYTES } from "../constants";
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
} from "@patternfly/react-icons";
import { Table, Thead, Tr, Th, Tbody, Td, ThProps } from "@patternfly/react-table";
import {
  UpdateInfo,
  SyncPackageDetails,
  PreflightResponse,
  StreamEvent,
  checkUpdates,
  runUpgrade,
  syncDatabase,
  getSyncPackageInfo,
  preflightUpgrade,
  formatSize,
  listIgnoredPackages,
} from "../api";

import { PackageDetailsModal } from "./PackageDetailsModal";
import { PinnedPackagesModal } from "./PinnedPackagesModal";

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

export const UpdatesView: React.FC = () => {
  const [state, setState] = useState<ViewState>("loading");
  const [updates, setUpdates] = useState<UpdateInfo[]>([]);
  const [log, setLog] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [warnings, setWarnings] = useState<string[]>([]);
  const cancelRef = useRef<(() => void) | null>(null);
  const logContainerRef = useRef<HTMLDivElement | null>(null);
  const [selectedPackage, setSelectedPackage] = useState<SyncPackageDetails | null>(null);
  const [packageLoading, setPackageLoading] = useState(false);
  const [searchFilter, setSearchFilter] = useState("");
  const [repoFilter, setRepoFilter] = useState("all");
  const [repoSelectOpen, setRepoSelectOpen] = useState(false);
  const [confirmModalOpen, setConfirmModalOpen] = useState(false);
  const [preflightData, setPreflightData] = useState<PreflightResponse | null>(null);
  const [preflightLoading, setPreflightLoading] = useState(false);
  const [activeSortIndex, setActiveSortIndex] = useState<number | null>(null);
  const [activeSortDirection, setActiveSortDirection] = useState<"asc" | "desc">("asc");
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
  const [pinnedPackages, setPinnedPackages] = useState<string[]>([]);
  const [pinnedModalOpen, setPinnedModalOpen] = useState(false);

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

  const sortableColumns = [1, 2, 4, 5, 6]; // name, repo, download, installed, net (offset by 1 for checkbox column)

  const getSortParams = (columnIndex: number): ThProps["sort"] | undefined => {
    if (!sortableColumns.includes(columnIndex)) return undefined;
    return {
      sortBy: {
        index: activeSortIndex ?? undefined,
        direction: activeSortDirection,
        defaultDirection: "desc", // Start with Z-A since data is already A-Z
      },
      onSort: (_event, index, direction) => {
        setActiveSortIndex(index);
        setActiveSortDirection(direction);
      },
      columnIndex,
    };
  };

  const sortedUpdates = useMemo(() => {
    if (activeSortIndex === null) return filteredUpdates;

    return [...filteredUpdates].sort((a, b) => {
      let comparison = 0;
      switch (activeSortIndex) {
        case 1: // name
          comparison = a.name.localeCompare(b.name);
          break;
        case 2: // repository
          comparison = a.repository.localeCompare(b.repository);
          break;
        case 4: // download_size
          comparison = a.download_size - b.download_size;
          break;
        case 5: // new_size (installed size after upgrade)
          comparison = a.new_size - b.new_size;
          break;
        case 6: // net_size (new - current)
          comparison = (a.new_size - a.current_size) - (b.new_size - b.current_size);
          break;
        default:
          return 0;
      }
      return activeSortDirection === "asc" ? comparison : -comparison;
    });
  }, [filteredUpdates, activeSortIndex, activeSortDirection]);

  // Calculate ignored packages (unselected ones)
  const ignoredPackages = useMemo(() => {
    return updates.filter((u) => !selectedPackages.has(u.name)).map((u) => u.name);
  }, [updates, selectedPackages]);

  // Calculate selected updates for summary
  const selectedUpdates = useMemo(() => {
    return updates.filter((u) => selectedPackages.has(u.name));
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

  const loadPinnedPackages = useCallback(async () => {
    try {
      const response = await listIgnoredPackages();
      setPinnedPackages(response.packages);
    } catch {
      // Ignore errors loading pinned packages
    }
  }, []);

  useEffect(() => {
    loadPinnedPackages();
  }, [loadPinnedPackages]);

  // Initialize selected packages when updates load, excluding pinned packages
  useEffect(() => {
    const nonPinned = updates
      .filter((u) => !pinnedPackages.includes(u.name))
      .map((u) => u.name);
    setSelectedPackages(new Set(nonPinned));
  }, [updates, pinnedPackages]);

  useEffect(() => {
    return () => {
      if (cancelRef.current) {
        cancelRef.current();
      }
    };
  }, []);

  // Auto-scroll log to bottom when new content is added
  useEffect(() => {
    if (logContainerRef.current) {
      logContainerRef.current.scrollTop = logContainerRef.current.scrollHeight;
    }
  }, [log]);

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
        // Show confirmation modal
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
          {warnings.length > 0 && (
            <Alert variant="warning" title="Warnings" className="pf-v6-u-mb-md">
              <ul className="pf-v6-u-m-0 pf-v6-u-pl-lg">
                {warnings.map((w, i) => <li key={`${w}-${i}`}>{w}</li>)}
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
    <Card>
      <CardBody>
        {warnings.length > 0 && (
          <Alert variant="warning" title="Warnings" className="pf-v6-u-mb-md">
            <ul className="pf-v6-u-m-0 pf-v6-u-pl-lg">
              {warnings.map((w, i) => <li key={`${w}-${i}`}>{w}</li>)}
            </ul>
          </Alert>
        )}
        {ignoredPackages.length > 0 && (
          <Alert variant="warning" title="Partial upgrade" isInline className="pf-v6-u-mb-md">
            Skipping {ignoredPackages.length} package{ignoredPackages.length !== 1 ? "s" : ""}. Partial upgrades are unsupported and may cause dependency issues.
          </Alert>
        )}
        <Flex justifyContent={{ default: "justifyContentSpaceBetween" }} alignItems={{ default: "alignItemsFlexStart" }}>
          <FlexItem>
            <CardTitle className="pf-v6-u-m-0 pf-v6-u-mb-md">
              {selectedPackages.size} of {updates.length} update{updates.length !== 1 ? "s" : ""} selected
              {filteredUpdates.length !== updates.length && ` (${filteredUpdates.length} shown)`}
            </CardTitle>
            <Flex spaceItems={{ default: "spaceItemsLg" }} className="pf-v6-u-mb-md">
              <FlexItem>
                <div style={{ textAlign: "center", padding: "0.75rem 1.5rem", background: "var(--pf-t--global--background--color--secondary--default)", borderRadius: "6px" }}>
                  <div style={{ fontSize: "1.5rem", fontWeight: 600, color: "var(--pf-t--global--color--status--info--default)" }}>{formatSize(selectedDownloadSize)}</div>
                  <div style={{ fontSize: "0.75rem", color: "var(--pf-t--global--text--color--subtle)", textTransform: "uppercase" }}>Download Size</div>
                </div>
              </FlexItem>
              <FlexItem>
                <div style={{ textAlign: "center", padding: "0.75rem 1.5rem", background: "var(--pf-t--global--background--color--secondary--default)", borderRadius: "6px" }}>
                  <div style={{ fontSize: "1.5rem", fontWeight: 600 }}>{formatSize(selectedNewSize)}</div>
                  <div style={{ fontSize: "0.75rem", color: "var(--pf-t--global--text--color--subtle)", textTransform: "uppercase" }}>Installed Size</div>
                </div>
              </FlexItem>
              <FlexItem>
                <div style={{ textAlign: "center", padding: "0.75rem 1.5rem", background: "var(--pf-t--global--background--color--secondary--default)", borderRadius: "6px" }}>
                  <div style={{ fontSize: "1.5rem", fontWeight: 600, color: selectedNetSize > 0 ? "var(--pf-t--global--color--status--danger--default)" : selectedNetSize < 0 ? "var(--pf-t--global--color--status--success--default)" : undefined }}>
                    {selectedNetSize >= 0 ? "+" : ""}{formatSize(selectedNetSize)}
                  </div>
                  <div style={{ fontSize: "0.75rem", color: "var(--pf-t--global--text--color--subtle)", textTransform: "uppercase" }}>Net Size</div>
                </div>
              </FlexItem>
            </Flex>
          </FlexItem>
          <FlexItem>
            <Button
              variant="secondary"
              onClick={() => setPinnedModalOpen(true)}
              className="pf-v6-u-mr-sm"
            >
              Manage Pinned{pinnedPackages.length > 0 ? ` (${pinnedPackages.length})` : ""}
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
              {preflightLoading ? "Checking..." : `Apply ${selectedPackages.size} Update${selectedPackages.size !== 1 ? "s" : ""}`}
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
              <Th sort={getSortParams(1)}>Package</Th>
              <Th sort={getSortParams(2)}>Repository</Th>
              <Th>Version</Th>
              <Th sort={getSortParams(4)}>Download</Th>
              <Th sort={getSortParams(5)}>Installed</Th>
              <Th sort={getSortParams(6)}>Net</Th>
            </Tr>
          </Thead>
          <Tbody>
            {sortedUpdates.map((update) => {
              const netSize = update.new_size - update.current_size;
              const isSelected = selectedPackages.has(update.name);
              const isPinned = pinnedPackages.includes(update.name);
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
                    {isPinned && (
                      <Label color="orange" className="pf-v6-u-ml-sm" isCompact>
                        pinned
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
                    {netSize >= 0 ? "+" : ""}{formatSize(netSize)}
                  </Td>
                </Tr>
              );
            })}
          </Tbody>
        </Table>
      </CardBody>

      <PackageDetailsModal
        packageDetails={selectedPackage}
        isLoading={packageLoading}
        onClose={handleCloseModal}
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

              {(preflightData.conflicts?.length ?? 0) > 0 && (
                <>
                  <Content component={ContentVariants.h4}>Package Conflicts</Content>
                  <List>
                    {preflightData.conflicts!.map((c, i) => (
                      <ListItem key={i}>
                        {c.package1} conflicts with {c.package2}
                      </ListItem>
                    ))}
                  </List>
                </>
              )}

              {(preflightData.replacements?.length ?? 0) > 0 && (
                <>
                  <Content component={ContentVariants.h4}>Package Replacements</Content>
                  <List>
                    {preflightData.replacements!.map((r, i) => (
                      <ListItem key={i}>
                        {r.old_package} will be replaced by {r.new_package}
                      </ListItem>
                    ))}
                  </List>
                </>
              )}

              {(preflightData.removals?.length ?? 0) > 0 && (
                <>
                  <Content component={ContentVariants.h4}>Packages to Remove</Content>
                  <List>
                    {preflightData.removals!.map((pkg, i) => (
                      <ListItem key={i}>{pkg}</ListItem>
                    ))}
                  </List>
                </>
              )}

              {(preflightData.providers?.length ?? 0) > 0 && (
                <>
                  <Content component={ContentVariants.h4}>Provider Selections</Content>
                  <List>
                    {preflightData.providers!.map((p, i) => (
                      <ListItem key={i}>
                        {p.dependency}: {p.providers[0]} will be selected (from: {p.providers.join(", ")})
                      </ListItem>
                    ))}
                  </List>
                </>
              )}

              {(preflightData.import_keys?.length ?? 0) > 0 && (
                <>
                  <Content component={ContentVariants.h4}>PGP Keys to Import</Content>
                  <List>
                    {preflightData.import_keys!.map((k, i) => (
                      <ListItem key={i}>
                        {k.fingerprint} ({k.uid})
                      </ListItem>
                    ))}
                  </List>
                </>
              )}

              <Content component={ContentVariants.p} className="pf-v6-u-mt-md">
                <strong>{preflightData.packages_to_upgrade}</strong> packages will be upgraded
                (download: {formatSize(preflightData.total_download_size)})
              </Content>
            </Content>
          )}
        </ModalBody>
        <ModalFooter>
          <Button key="confirm" variant="primary" onClick={startUpgrade}>
            Proceed with Upgrade
          </Button>
          <Button key="cancel" variant="link" onClick={() => setConfirmModalOpen(false)}>
            Cancel
          </Button>
        </ModalFooter>
      </Modal>

      <PinnedPackagesModal
        isOpen={pinnedModalOpen}
        onClose={() => setPinnedModalOpen(false)}
        onPinnedChange={() => loadPinnedPackages()}
      />
    </Card>
  );
};
