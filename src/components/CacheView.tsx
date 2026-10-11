import React, { useState, useEffect, useCallback, useRef } from "react";
import { useBackdropClose } from "../hooks/useBackdropClose";
import { usePackageDetails } from "../hooks/usePackageDetails";
import { usePagination } from "../hooks/usePagination";
import { useDebouncedValue } from "../hooks/useDebounce";
import { SEARCH_DEBOUNCE_MS } from "../constants";
import { useSortableTable } from "../hooks/useSortableTable";
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
  Modal,
  ModalVariant,
  ModalHeader,
  ModalBody,
  ModalFooter,
  Content,
  ContentVariants,
  Slider,
  SearchInput,
  Toolbar,
  ToolbarContent,
  ToolbarItem,
  Popover,
  Icon,
  Alert,
} from "@patternfly/react-core";
import { ExpandableLogViewer, LogViewer } from "./LogViewer";
import { CacheFilesModal } from "./CacheFilesModal";
import { CompactPagination } from "./CompactPagination";
import { TrashIcon, CheckCircleIcon, FolderIcon, ExclamationCircleIcon, OutlinedQuestionCircleIcon } from "@patternfly/react-icons";
import { PackageDetailsModal } from "./PackageDetailsModal";
import { StatBox } from "./StatBox";
import { Table, Thead, Tr, Th, Tbody, Td } from "@patternfly/react-table";
import {
  CacheInfo,
  CacheSelection,
  getCacheInfo,
  cleanCache,
  formatSize,
} from "../api";
import { appendCapped, sanitizeErrorMessage } from "../utils";

type ViewState = "ready" | "cleaning" | "success" | "error";

export const CacheView: React.FC = () => {
  const [state, setState] = useState<ViewState>("ready");
  const [cacheData, setCacheData] = useState<CacheInfo | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [log, setLog] = useState("");
  const [isDetailsExpanded, setIsDetailsExpanded] = useState(false);
  const [confirmModalOpen, setConfirmModalOpen] = useState(false);
  useBackdropClose(confirmModalOpen, () => setConfirmModalOpen(false));
  const [keepVersions, setKeepVersions] = useState(3);
  const [searchFilter, setSearchFilter] = useState("");
  const [selection, setSelection] = useState<{ all: boolean; names: Set<string> }>({ all: true, names: new Set() });
  const [filesPackage, setFilesPackage] = useState<string | null>(null);
  const [refresh, setRefresh] = useState(0);
  const [loading, setLoading] = useState(true);
  const debouncedSearch = useDebouncedValue(searchFilter, SEARCH_DEBOUNCE_MS);
  const { selectedPackage, detailsLoading, detailsError, fetchDetails, clearDetails } = usePackageDetails();
  const { page, perPage, setPage, onSetPage, onPerPageSelect, resetPage } = usePagination();
  const cancelRef = useRef<(() => void) | null>(null);
  const isMountedRef = useRef(true);

  const { activeSortKey, activeSortDirection, getSortParams } = useSortableTable({
    columns: { name: 0, version: 1, size: 2 },
    defaultDirection: "asc",
    onSort: resetPage,
  });

  const loadCacheInfo = useCallback(() => {
    setRefresh(value => value + 1);
    setPage(1);
  }, [setPage]);

  useEffect(() => {
    let cancelled = false;
    Promise.resolve().then(async () => {
      if (cancelled) return;
      setLoading(true);
      setError(null);
      try {
        const response = await getCacheInfo({
          offset: (page - 1) * perPage,
          limit: perPage,
          search: debouncedSearch,
          sortBy: activeSortKey ?? "name",
          sortDir: activeSortDirection,
        });
        if (cancelled) return;
        const lastPage = Math.max(1, Math.ceil(response.total / perPage));
        if (page > lastPage) {
          setPage(lastPage);
          return;
        }
        setCacheData(response);
        setState("ready");
      } catch (ex) {
        if (cancelled) return;
        setState("error");
        setError(ex instanceof Error ? ex.message : String(ex));
      } finally {
        if (!cancelled) setLoading(false);
      }
    });
    return () => { cancelled = true; };
  }, [page, perPage, debouncedSearch, activeSortKey, activeSortDirection, refresh, setPage]);

  useEffect(() => {
    isMountedRef.current = true;
    return () => {
      isMountedRef.current = false;
      cancelRef.current?.();
    };
  }, []);

  const hasSelection = selection.all || selection.names.size > 0;
  const areAllSelected = selection.all && selection.names.size === 0;
  const areSomeSelected = hasSelection && !areAllSelected;

  const handleRowClick = (pkgName: string) => {
    fetchDetails(pkgName, { strategy: "local-then-sync" });
  };

  const handleCleanCache = () => {
    setConfirmModalOpen(true);
  };

  const startCleanup = () => {
    if (!hasSelection || loading || searchFilter !== debouncedSearch) return;
    setConfirmModalOpen(false);
    setState("cleaning");
    setLog("");
    setIsDetailsExpanded(true);

    const packages: CacheSelection = selection.all
      ? selection.names.size === 0 ? { mode: "all" } : { mode: "except", names: [...selection.names] }
      : { mode: "only", names: [...selection.names] };
    const { cancel } = cleanCache(
      {
        onData: (data) => { if (isMountedRef.current) setLog((prev) => appendCapped(prev, data)); },
        onComplete: () => {
          if (!isMountedRef.current) return;
          setState("success");
          setSelection({ all: true, names: new Set() });
          cancelRef.current = null;
        },
        onError: (err) => {
          if (!isMountedRef.current) return;
          setState("error");
          setError(err);
          cancelRef.current = null;
        },
      },
      keepVersions,
      packages
    );
    cancelRef.current = cancel;
  };

  const handleCancel = () => {
    if (cancelRef.current) {
      cancelRef.current();
      cancelRef.current = null;
      setState("ready");
      setLog("");
    }
  };

  const togglePackageSelection = (name: string) => {
    setSelection(previous => {
      const names = new Set(previous.names);
      if (names.has(name)) names.delete(name);
      else names.add(name);
      return { all: previous.all, names };
    });
  };

  if (loading && !cacheData) {
    return (
      <Card>
        <CardBody>
          <EmptyState headingLevel="h2" icon={Spinner} titleText="Loading cache information">
            <EmptyStateBody>Scanning package cache...</EmptyStateBody>
          </EmptyState>
        </CardBody>
      </Card>
    );
  }

  if (state === "error") {
    return (
      <Card>
        <CardBody>
          <EmptyState headingLevel="h2" icon={ExclamationCircleIcon} titleText="Error loading cache information" status="danger">
            <EmptyStateBody>{sanitizeErrorMessage(error)}</EmptyStateBody>
            <EmptyStateFooter>
              <EmptyStateActions>
                <Button variant="primary" onClick={loadCacheInfo}>Retry</Button>
              </EmptyStateActions>
            </EmptyStateFooter>
          </EmptyState>
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
              <CardTitle className="pf-v6-u-m-0">Cleaning Package Cache</CardTitle>
            </FlexItem>
            <FlexItem>
              <Button variant="danger" onClick={handleCancel}>
                Cancel
              </Button>
            </FlexItem>
          </Flex>

          <div className="pf-v6-u-mt-md pf-v6-u-mb-md">
            <Spinner size="md" /> Cleaning cache (keeping {keepVersions} version{keepVersions !== 1 ? "s" : ""})...
          </div>

          <ExpandableLogViewer
            log={log}
            placeholder="Starting..."
            isExpanded={isDetailsExpanded}
            onToggle={setIsDetailsExpanded}
          />
        </CardBody>
      </Card>
    );
  }

  if (state === "success") {
    return (
      <Card>
        <CardBody>
          <EmptyState headingLevel="h2" icon={CheckCircleIcon} titleText="Cache cleaned">
            <EmptyStateBody>
              Old package versions have been removed from the cache.
            </EmptyStateBody>
            <EmptyStateFooter>
              <EmptyStateActions>
                <Button variant="primary" onClick={loadCacheInfo}>
                  View Cache
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
          <EmptyState headingLevel="h2" icon={FolderIcon} titleText="Cache is empty">
            <EmptyStateBody>
              The package cache at {cacheData?.path || "/var/cache/pacman/pkg"} contains no packages.
            </EmptyStateBody>
            <EmptyStateFooter>
              <EmptyStateActions>
                <Button variant="secondary" onClick={loadCacheInfo}>
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
            <CardTitle className="pf-v6-u-m-0">
              Package Cache{" "}
              <Popover
                headerContent="Cache directory"
                bodyContent={cacheData.path}
              >
                <Icon isInline style={{ cursor: "pointer" }}>
                  <OutlinedQuestionCircleIcon />
                </Icon>
              </Popover>
            </CardTitle>
            <Flex spaceItems={{ default: "spaceItemsLg" }} className="pf-v6-u-mb-md">
              <FlexItem>
                <StatBox
                  label="Total Size"
                  value={formatSize(cacheData.total_size)}
                />
              </FlexItem>
              <FlexItem>
                <StatBox
                  label="Cached Files"
                  value={(cacheData.package_count).toLocaleString()}
                />
              </FlexItem>
              <FlexItem>
                <StatBox
                  label="Unique Packages"
                  value={cacheData.unique_packages.toLocaleString()}
                />
              </FlexItem>
              <FlexItem>
                <StatBox
                  label="Multi-Version"
                  value={cacheData.multi_version_packages.toLocaleString()}
                  color={cacheData.multi_version_packages > 0 ? "info" : "default"}
                />
              </FlexItem>
            </Flex>
          </FlexItem>
        </Flex>

        <Toolbar>
          <ToolbarContent>
            <ToolbarItem>
              <SearchInput
                placeholder="Filter cached packages..."
                value={searchFilter}
                onChange={(_event, value) => { setSearchFilter(value); resetPage(); }}
                onClear={() => { setSearchFilter(""); resetPage(); }}
                aria-label="Filter cached packages"
              />
            </ToolbarItem>
            <ToolbarItem>
              <Button
                variant="secondary"
                icon={<TrashIcon />}
                onClick={handleCleanCache}
                isDisabled={!hasSelection || loading || searchFilter !== debouncedSearch}
              >
                {hasSelection && !areAllSelected ? "Clean selected packages" : "Clean Cache"}
              </Button>
            </ToolbarItem>
            <ToolbarItem>
              <Button variant="plain" onClick={loadCacheInfo} isDisabled={loading}>Refresh</Button>
            </ToolbarItem>
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
        {!loading && cacheData.total === 0 && (
          <Alert variant="info" isInline title="No cached packages match this filter" />
        )}
        <Table aria-label="Cached packages" variant="compact" aria-busy={loading}>
          <Thead>
            <Tr>
              <Th screenReaderText="Select">
                <Checkbox
                  id="select-all-cache"
                  isChecked={areAllSelected ? true : areSomeSelected ? null : false}
                  onChange={(_event, checked) => setSelection({ all: checked, names: new Set() })}
                  aria-label="Select all packages"
                />
              </Th>
              <Th sort={getSortParams(0)}>Package</Th>
              <Th sort={getSortParams(1)}>Version</Th>
              <Th sort={getSortParams(2)}>Size</Th>
            </Tr>
          </Thead>
          <Tbody>
            {cacheData.groups.map((group, rowIndex) => {
              const isSelected = selection.all !== selection.names.has(group.name);
              return (
              <Tr key={group.name} isClickable onRowClick={() => handleRowClick(group.name)} isRowSelected={isSelected}>
                <Td
                  select={{
                    rowIndex,
                    onSelect: () => togglePackageSelection(group.name),
                    isSelected,
                  }}
                  onClick={(e) => e.stopPropagation()}
                />
                <Td dataLabel="Package">
                  <Button variant="link" isInline className="pf-v6-u-p-0">
                    {group.name}
                  </Button>
                </Td>
                <Td dataLabel="Version">
                  <div>{group.latest_version}</div>
                  <Button
                    variant="link"
                    isInline
                    aria-label={`View cached files for ${group.name}`}
                    onClick={event => { event.stopPropagation(); setFilesPackage(group.name); }}
                  >
                    {group.file_count} file{group.file_count === 1 ? "" : "s"}
                  </Button>
                </Td>
                <Td dataLabel="Size">{formatSize(group.total_size)}</Td>
              </Tr>
              );
            })}
          </Tbody>
        </Table>
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
      </CardBody>

      <Modal
        variant={ModalVariant.small}
        aria-label="Clean package cache?"
        isOpen={confirmModalOpen}
        onClose={() => setConfirmModalOpen(false)}
      >
        <ModalHeader title="Clean package cache?" />
        <ModalBody>
          <Content>
            <Content component={ContentVariants.p}>
              {areAllSelected
                ? "This will remove old versions of all cached packages, keeping only the most recent versions."
                : selection.all
                  ? "This will clean all cached packages except those you deselected."
                  : "This will clean only the packages you selected."}
            </Content>
            <Content component={ContentVariants.p} className="pf-v6-u-mt-md pf-v6-u-mb-sm">
              <strong>Versions to keep:</strong>{" "}
              <Popover
                headerContent="How many versions to keep"
                bodyContent="0 deletes every cached version of each selected package, including the currently installed version. 1 or more keeps the N most recent versions of each selected package, letting you downgrade later without re-downloading."
              >
                <Icon isInline style={{ cursor: "pointer" }}>
                  <OutlinedQuestionCircleIcon />
                </Icon>
              </Popover>
            </Content>
            <Slider
              value={keepVersions}
              onChange={(_event, value) => setKeepVersions(value)}
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
                ? "All cached versions of the selected packages will be removed."
                : `The ${keepVersions} most recent version${keepVersions !== 1 ? "s" : ""} of each selected package will be kept.`}
            </Content>
          </Content>
        </ModalBody>
        <ModalFooter>
          <Button key="confirm" variant="primary" onClick={startCleanup} isDisabled={!hasSelection || loading || searchFilter !== debouncedSearch}>
            Clean Cache
          </Button>
          <Button key="cancel" variant="link" onClick={() => setConfirmModalOpen(false)}>
            Cancel
          </Button>
        </ModalFooter>
      </Modal>

      {filesPackage !== null && (
        <CacheFilesModal name={filesPackage} onClose={() => setFilesPackage(null)} />
      )}

      <PackageDetailsModal
        packageDetails={selectedPackage}
        isLoading={detailsLoading}
        onClose={clearDetails}
        error={detailsError}
      />
    </Card>
  );
};
