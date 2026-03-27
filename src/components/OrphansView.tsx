import React, { useState, useEffect, useCallback, useRef, useMemo } from "react";
import { useAutoScrollLog } from "../hooks/useAutoScrollLog";
import { useBackdropClose } from "../hooks/useBackdropClose";
import { useSortableTable } from "../hooks/useSortableTable";
import {
  Button,
  Spinner,
  Alert,
  Modal,
  ModalVariant,
  ModalHeader,
  ModalBody,
  ModalFooter,
  Content,
  ContentVariants,
  EmptyState,
  EmptyStateBody,
  EmptyStateActions,
  EmptyStateFooter,
  CodeBlock,
  CodeBlockCode,
  ExpandableSection,
  Flex,
  FlexItem,
  Badge,
  Checkbox,
  Label,
  SearchInput,
  ToggleGroup,
  ToggleGroupItem,
} from "@patternfly/react-core";
import { TrashIcon, CheckCircleIcon } from "@patternfly/react-icons";
import { StatBox } from "./StatBox";
import { Table, Thead, Tr, Th, Tbody, Td } from "@patternfly/react-table";
import {
  OrphanPackage,
  OrphanResponse,
  listOrphans,
  removeOrphans,
  formatSize,
  formatDate,
} from "../api";
import { LOG_CONTAINER_HEIGHT, MAX_LOG_SIZE_BYTES } from "../constants";

type ViewState = "loading" | "ready" | "removing" | "success";
type OrphanFilter = "all" | "direct" | "indirect";

interface OrphansViewProps {
  onRowClick: (pkgName: string) => void;
  onOrphansLoaded?: (count: number) => void;
  refreshTrigger?: number;
}

export const OrphansView: React.FC<OrphansViewProps> = ({ onRowClick, onOrphansLoaded, refreshTrigger }) => {
  const [orphanData, setOrphanData] = useState<OrphanResponse | null>(null);
  const [viewState, setViewState] = useState<ViewState>("loading");
  const [error, setError] = useState<string | null>(null);
  const [searchValue, setSearchValue] = useState("");
  const [orphanFilter, setOrphanFilter] = useState<OrphanFilter>("all");
  const [selectedPackages, setSelectedPackages] = useState<Set<string>>(new Set());
  const hasInitializedSelection = useRef(false);
  const [confirmModalOpen, setConfirmModalOpen] = useState(false);
  useBackdropClose(confirmModalOpen, () => setConfirmModalOpen(false));
  const [log, setLog] = useState("");
  const [logExpanded, setLogExpanded] = useState(false);
  const cancelRef = useRef<(() => void) | null>(null);
  const isMountedRef = useRef(true);
  const logContainerRef = useAutoScrollLog(log);

  const { activeSortIndex, activeSortDirection, getSortParams } = useSortableTable({
    sortableColumns: [1, 2, 4, 5],
    defaultDirection: "asc",
  });

  useEffect(() => {
    isMountedRef.current = true;
    return () => {
      isMountedRef.current = false;
    };
  }, []);

  useEffect(() => {
    return () => {
      if (cancelRef.current) {
        cancelRef.current();
      }
    };
  }, []);

  const loadOrphans = useCallback(async () => {
    setViewState("loading");
    setError(null);
    try {
      const response = await listOrphans();
      if (!isMountedRef.current) return;
      setOrphanData(response);
      onOrphansLoaded?.(response.orphans.length);
      setViewState("ready");
    } catch (ex) {
      if (!isMountedRef.current) return;
      setError(ex instanceof Error ? ex.message : String(ex));
      setViewState("ready");
    }
  }, [onOrphansLoaded]);

  useEffect(() => {
    loadOrphans();
  }, [loadOrphans, refreshTrigger]);

  useEffect(() => {
    const orphans = orphanData?.orphans ?? [];
    if (orphans.length === 0) {
      hasInitializedSelection.current = false;
      return;
    }
    if (hasInitializedSelection.current) {
      setSelectedPackages((prev) => {
        const existing = new Set(orphans.map((p) => p.name));
        const next = new Set<string>();
        for (const pkg of prev) {
          if (existing.has(pkg)) next.add(pkg);
        }
        return next;
      });
      return;
    }
    setSelectedPackages(new Set(orphans.map((p) => p.name)));
    hasInitializedSelection.current = true;
  }, [orphanData]);

  const togglePackageSelection = (name: string) => {
    setSelectedPackages((prev) => {
      const next = new Set(prev);
      if (next.has(name)) next.delete(name);
      else next.add(name);
      return next;
    });
  };

  const selectedSize = useMemo(() => {
    if (!orphanData?.orphans) return 0;
    return orphanData.orphans
      .filter((p) => selectedPackages.has(p.name))
      .reduce((sum, p) => sum + p.installed_size, 0);
  }, [orphanData, selectedPackages]);

  const startRemoval = () => {
    setConfirmModalOpen(false);
    setViewState("removing");
    setLog("");
    setLogExpanded(true);

    const packages = Array.from(selectedPackages);
    const { cancel } = removeOrphans({
      onData: (data) => setLog((prev) => {
        const newLog = prev + data;
        return newLog.length > MAX_LOG_SIZE_BYTES ? newLog.slice(-MAX_LOG_SIZE_BYTES) : newLog;
      }),
      onComplete: () => {
        setViewState("success");
        setOrphanData(null);
        cancelRef.current = null;
      },
      onError: (err) => {
        setViewState("ready");
        setError(err);
        cancelRef.current = null;
      },
    }, packages);
    cancelRef.current = cancel;
  };

  const handleCancel = () => {
    if (cancelRef.current) {
      cancelRef.current();
      cancelRef.current = null;
      setViewState("ready");
      setLog("");
    }
  };

  const handleSuccessRefresh = () => {
    setViewState("loading");
    setLog("");
    loadOrphans();
  };

  const orphanCounts = useMemo(() => {
    if (!orphanData?.orphans) return { total: 0, direct: 0, indirect: 0 };
    const direct = orphanData.orphans.filter((p) => p.direct).length;
    return { total: orphanData.orphans.length, direct, indirect: orphanData.orphans.length - direct };
  }, [orphanData]);

  const filteredAndSorted = useMemo(() => {
    if (!orphanData?.orphans) return [];
    let filtered = orphanData.orphans;
    if (orphanFilter === "direct") filtered = filtered.filter((p) => p.direct);
    else if (orphanFilter === "indirect") filtered = filtered.filter((p) => !p.direct);
    const searchLower = searchValue.toLowerCase();
    if (searchValue) {
      filtered = filtered.filter(pkg =>
        pkg.name.toLowerCase().includes(searchLower) ||
        (pkg.description?.toLowerCase().includes(searchLower) ?? false)
      );
    }
    return [...filtered].sort((a, b) => {
      if (activeSortIndex === null) return 0;
      let comparison = 0;
      switch (activeSortIndex) {
        case 1:
          comparison = a.name.localeCompare(b.name);
          break;
        case 2:
          comparison = Number(b.direct) - Number(a.direct);
          break;
        case 4:
          comparison = a.installed_size - b.installed_size;
          break;
        case 5:
          comparison = (a.install_date ?? 0) - (b.install_date ?? 0);
          break;
        default:
          return 0;
      }
      return activeSortDirection === "asc" ? comparison : -comparison;
    });
  }, [orphanData, activeSortIndex, activeSortDirection, searchValue, orphanFilter]);

  useEffect(() => {
    const visibleNames = new Set(filteredAndSorted.map((p) => p.name));
    setSelectedPackages((prev) => {
      const next = new Set<string>();
      for (const name of prev) {
        if (visibleNames.has(name)) next.add(name);
      }
      return next;
    });
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [orphanFilter, searchValue]);

  const selectAllPackages = () => {
    setSelectedPackages((prev) => {
      const next = new Set(prev);
      for (const pkg of filteredAndSorted) next.add(pkg.name);
      return next;
    });
  };

  const deselectAllPackages = () => {
    setSelectedPackages((prev) => {
      const next = new Set(prev);
      for (const pkg of filteredAndSorted) next.delete(pkg.name);
      return next;
    });
  };

  const allVisibleSelected = filteredAndSorted.length > 0 && filteredAndSorted.every((p) => selectedPackages.has(p.name));
  const someVisibleSelected = filteredAndSorted.some((p) => selectedPackages.has(p.name)) && !allVisibleSelected;

  if (viewState === "loading") {
    return (
      <div className="pf-v6-u-p-xl pf-v6-u-text-align-center">
        <Spinner /> Checking for orphan packages...
      </div>
    );
  }

  if (error) {
    const isLockError = error.toLowerCase().includes("unable to lock database");
    return (
      <>
        <Alert
          variant={isLockError ? "warning" : "danger"}
          title={isLockError ? "Database is locked" : "Error loading orphans"}
        >
          {isLockError
            ? "Another package manager operation is in progress. Please wait for it to complete."
            : error}
        </Alert>
      </>
    );
  }

  if (viewState === "removing") {
    return (
      <>
        <Flex justifyContent={{ default: "justifyContentSpaceBetween" }} alignItems={{ default: "alignItemsCenter" }} className="pf-v6-u-mb-md">
          <FlexItem>
            <strong>Removing Orphan Packages</strong>
          </FlexItem>
          <FlexItem>
            <Button variant="danger" onClick={handleCancel}>
              Cancel
            </Button>
          </FlexItem>
        </Flex>

        <div className="pf-v6-u-mb-md">
          <Spinner size="md" /> Removing packages...
        </div>

        <ExpandableSection
          toggleText={logExpanded ? "Hide details" : "Show details"}
          onToggle={(_event, expanded) => setLogExpanded(expanded)}
          isExpanded={logExpanded}
        >
          <div ref={logContainerRef} style={{ maxHeight: LOG_CONTAINER_HEIGHT, overflow: "auto" }}>
            <CodeBlock>
              <CodeBlockCode>{log || "Starting..."}</CodeBlockCode>
            </CodeBlock>
          </div>
        </ExpandableSection>
      </>
    );
  }

  if (viewState === "success") {
    return (
      <>
        <EmptyState headingLevel="h2" icon={CheckCircleIcon} titleText="Orphan packages removed">
          <EmptyStateBody>
            Selected packages have been successfully removed.
          </EmptyStateBody>
          <EmptyStateFooter>
            <EmptyStateActions>
              <Button variant="primary" onClick={handleSuccessRefresh}>
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
      </>
    );
  }

  if (!orphanData?.orphans.length) {
    return (
      <EmptyState headingLevel="h2" icon={CheckCircleIcon} titleText="No orphan packages">
        <EmptyStateBody>
          Your system has no orphan packages. Orphans are packages that were installed as dependencies but are no longer required by any other package.
        </EmptyStateBody>
        <EmptyStateFooter>
          <EmptyStateActions>
            <Button variant="secondary" onClick={loadOrphans}>
              Refresh
            </Button>
          </EmptyStateActions>
        </EmptyStateFooter>
      </EmptyState>
    );
  }

  return (
    <>
      <Flex justifyContent={{ default: "justifyContentSpaceBetween" }} alignItems={{ default: "alignItemsCenter" }} className="pf-v6-u-mb-md">
        <Flex spaceItems={{ default: "spaceItemsMd" }} alignItems={{ default: "alignItemsCenter" }}>
          <FlexItem>
            <StatBox
              label="Space to Free"
              value={formatSize(selectedSize)}
              color="success"
            />
          </FlexItem>
          <FlexItem>
            <ToggleGroup aria-label="Orphan type filter">
              <ToggleGroupItem
                text={<>All <Badge isRead>{orphanCounts.total}</Badge></>}
                isSelected={orphanFilter === "all"}
                onChange={() => setOrphanFilter("all")}
              />
              <ToggleGroupItem
                text={<>Direct <Badge isRead>{orphanCounts.direct}</Badge></>}
                isSelected={orphanFilter === "direct"}
                onChange={() => setOrphanFilter("direct")}
              />
              <ToggleGroupItem
                text={<>Indirect <Badge isRead>{orphanCounts.indirect}</Badge></>}
                isSelected={orphanFilter === "indirect"}
                onChange={() => setOrphanFilter("indirect")}
              />
            </ToggleGroup>
          </FlexItem>
        </Flex>
        <Flex spaceItems={{ default: "spaceItemsMd" }} alignItems={{ default: "alignItemsCenter" }}>
          <FlexItem>
            <SearchInput
              placeholder="Filter orphans..."
              value={searchValue}
              onChange={(_event, value) => setSearchValue(value)}
              onClear={() => setSearchValue("")}
            />
          </FlexItem>
          <FlexItem>
            <Button
              variant="danger"
              icon={<TrashIcon />}
              onClick={() => setConfirmModalOpen(true)}
              isDisabled={selectedPackages.size === 0}
            >
              {selectedPackages.size > 0
                ? selectedPackages.size === orphanData?.orphans.length
                  ? "Remove All Orphans"
                  : `Remove ${selectedPackages.size} package${selectedPackages.size !== 1 ? "s" : ""}`
                : "Remove All Orphans"}
            </Button>
          </FlexItem>
        </Flex>
      </Flex>

      <Table aria-label="Orphan packages" variant="compact">
        <Thead>
          <Tr>
            <Th screenReaderText="Select">
              <Checkbox
                id="select-all-orphans"
                isChecked={allVisibleSelected ? true : someVisibleSelected ? null : false}
                onChange={(_event, checked) => checked ? selectAllPackages() : deselectAllPackages()}
                aria-label="Select all packages"
              />
            </Th>
            <Th sort={getSortParams(1)}>Package</Th>
            <Th sort={getSortParams(2)}>Reason</Th>
            <Th>Version</Th>
            <Th sort={getSortParams(4)}>Size</Th>
            <Th sort={getSortParams(5)}>Installed</Th>
            <Th>Repository</Th>
          </Tr>
        </Thead>
        <Tbody>
          {filteredAndSorted.map((pkg: OrphanPackage, index: number) => {
            const isSelected = selectedPackages.has(pkg.name);
            return (
            <Tr key={pkg.name} isClickable onRowClick={() => onRowClick(pkg.name)} isRowSelected={isSelected}>
              <Td
                select={{
                  rowIndex: index,
                  onSelect: () => togglePackageSelection(pkg.name),
                  isSelected,
                }}
                onClick={(e) => e.stopPropagation()}
              />
              <Td dataLabel="Package">
                <Button variant="link" isInline className="pf-v6-u-p-0">
                  {pkg.name}
                </Button>
              </Td>
              <Td dataLabel="Reason">
                <Label isCompact color={pkg.direct ? "orange" : "blue"}>
                  {pkg.direct ? "direct" : "indirect"}
                </Label>
              </Td>
              <Td dataLabel="Version">{pkg.version}</Td>
              <Td dataLabel="Size">{formatSize(pkg.installed_size)}</Td>
              <Td dataLabel="Installed">{formatDate(pkg.install_date)}</Td>
              <Td dataLabel="Repository">
                <Label isCompact color="grey">
                  {pkg.repository || "user"}
                </Label>
              </Td>
            </Tr>
            );
          })}
        </Tbody>
      </Table>

      <Modal
        variant={ModalVariant.small}
        isOpen={confirmModalOpen}
        onClose={() => setConfirmModalOpen(false)}
      >
        <ModalHeader title="Remove orphan packages?" />
        <ModalBody>
          <Content>
            <Content component={ContentVariants.p}>
              This will remove <strong>{selectedPackages.size}</strong> of {orphanData.orphans.length} orphan package{orphanData.orphans.length !== 1 ? "s" : ""} ({formatSize(selectedSize)}).
            </Content>
            <Content component={ContentVariants.p}>
              Orphan packages are dependencies that are no longer required by any explicitly installed package.
            </Content>
          </Content>
        </ModalBody>
        <ModalFooter>
          <Button key="confirm" variant="danger" onClick={startRemoval} isDisabled={selectedPackages.size === 0}>
            Remove {selectedPackages.size === orphanData?.orphans.length ? "All" : selectedPackages.size}
          </Button>
          <Button key="cancel" variant="link" onClick={() => setConfirmModalOpen(false)}>
            Cancel
          </Button>
        </ModalFooter>
      </Modal>
    </>
  );
};
