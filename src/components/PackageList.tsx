import React, { useState, useEffect, useCallback, useRef, useMemo } from "react";
import { useDebouncedValue } from "../hooks/useDebounce";
import { usePagination } from "../hooks/usePagination";
import { useSortableTable } from "../hooks/useSortableTable";
import { useAutoScrollLog } from "../hooks/useAutoScrollLog";
import {
  Card,
  CardBody,
  Spinner,
  Alert,
  SearchInput,
  Toolbar,
  ToolbarContent,
  ToolbarItem,
  ToggleGroup,
  ToggleGroupItem,
  Badge,
  Label,
  Pagination,
  MenuToggle,
  Select,
  SelectOption,
  SelectList,
  Button,
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
} from "@patternfly/react-core";
import { TrashIcon, CheckCircleIcon, TopologyIcon } from "@patternfly/react-icons";
import { StatBox } from "./StatBox";
import { Table, Thead, Tr, Th, Tbody, Td } from "@patternfly/react-table";
import { DependencyView } from "./DependencyView";
import {
  Package,
  PackageDetails,
  PackageListResponse,
  FilterType,
  OrphanPackage,
  OrphanResponse,
  listInstalled,
  listOrphans,
  removeOrphans,
  getPackageInfo,
  formatSize,
  formatDate,
  formatNumber,
} from "../api";
import { sanitizeSearchInput } from "../utils";
import { PackageDetailsModal } from "./PackageDetailsModal";
import { PER_PAGE_OPTIONS, SEARCH_DEBOUNCE_MS, LOG_CONTAINER_HEIGHT, MAX_LOG_SIZE_BYTES } from "../constants";

type OrphanViewState = "ready" | "removing" | "success";

interface PackageListProps {
  graphPackage?: string;
  onGraphPackageChange?: (packageName: string | undefined) => void;
}

export const PackageList: React.FC<PackageListProps> = ({ graphPackage, onGraphPackageChange }) => {
  const [packages, setPackages] = useState<Package[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [searchValue, setSearchValue] = useState("");
  const [searchInput, setSearchInput] = useState("");
  const [filter, setFilter] = useState<FilterType>("all");
  const [selectedPackage, setSelectedPackage] = useState<PackageDetails | null>(null);
  const [detailsLoading, setDetailsLoading] = useState(false);

  const { page, perPage, total, setPage, setTotal, onSetPage, onPerPageSelect } = usePagination();
  const [totalExplicit, setTotalExplicit] = useState(0);
  const [totalDependency, setTotalDependency] = useState(0);
  const [repositories, setRepositories] = useState<string[]>([]);
  const [repoFilter, setRepoFilter] = useState("all");
  const [repoSelectOpen, setRepoSelectOpen] = useState(false);
  const manualSearchRef = useRef(false);
  const isMountedRef = useRef(true);

  const [orphanData, setOrphanData] = useState<OrphanResponse | null>(null);
  const [orphanViewState, setOrphanViewState] = useState<OrphanViewState>("ready");
  const [orphanConfirmModalOpen, setOrphanConfirmModalOpen] = useState(false);
  const [orphanLog, setOrphanLog] = useState("");
  const [orphanLogExpanded, setOrphanLogExpanded] = useState(false);
  const orphanCancelRef = useRef<(() => void) | null>(null);
  const logContainerRef = useAutoScrollLog(orphanLog);

  const { activeSortIndex, activeSortDirection, getSortParams } = useSortableTable({
    sortableColumns: filter === "orphan" ? [0, 2, 3] : [0, 3, 4], // orphan: name, size, date; normal: name, size, reason
    defaultDirection: "asc",
    onSort: () => setPage(1),
  });

  useEffect(() => {
    isMountedRef.current = true;
    return () => {
      isMountedRef.current = false;
    };
  }, []);

  // Switch to graph view when graphPackage is set from outside
  useEffect(() => {
    if (graphPackage) {
      setFilter("graph");
    }
  }, [graphPackage]);

  const debouncedSearchInput = useDebouncedValue(
    sanitizeSearchInput(searchInput),
    SEARCH_DEBOUNCE_MS
  );

  useEffect(() => {
    if (manualSearchRef.current) {
      manualSearchRef.current = false;
      return;
    }
    if (debouncedSearchInput !== searchValue) {
      setSearchValue(debouncedSearchInput);
      setPage(1);
    }
  }, [debouncedSearchInput, searchValue, setPage]);

  // Map column index to backend sort field
  const getSortField = (index: number | null): string => {
    if (index === null) return "";
    switch (index) {
      case 0: return "name";
      case 3: return "size";
      case 4: return "reason";
      default: return "";
    }
  };

  const loadOrphanCount = useCallback(async () => {
    try {
      const response = await listOrphans();
      if (!isMountedRef.current) return;
      setOrphanData(response);
    } catch {
      // Silently fail orphan count - it's not critical
    }
  }, []);

  const loadPackages = useCallback(async () => {
    if (filter === "graph") {
      setLoading(false);
      return;
    }
    setLoading(true);
    setError(null);
    try {
      if (filter === "orphan") {
        const response = await listOrphans();
        if (!isMountedRef.current) return;
        setOrphanData(response);
        setPackages([]);
        setTotal(response.orphans.length);
      } else {
        const offset = (page - 1) * perPage;
        const response: PackageListResponse = await listInstalled({
          offset,
          limit: perPage,
          search: searchValue,
          filter,
          repo: repoFilter,
          sortBy: getSortField(activeSortIndex),
          sortDir: activeSortDirection,
        });
        if (!isMountedRef.current) return;
        setPackages(response.packages);
        setTotal(response.total);
        setTotalExplicit(response.total_explicit);
        setTotalDependency(response.total_dependency);
        setRepositories(response.repositories || []);
      }
    } catch (ex) {
      if (!isMountedRef.current) return;
      setError(ex instanceof Error ? ex.message : String(ex));
    } finally {
      if (isMountedRef.current) {
        setLoading(false);
      }
    }
  }, [page, perPage, searchValue, filter, repoFilter, activeSortIndex, activeSortDirection, setTotal]);

  useEffect(() => {
    loadPackages();
  }, [loadPackages]);

  useEffect(() => {
    loadOrphanCount();
  }, [loadOrphanCount]);

  useEffect(() => {
    return () => {
      if (orphanCancelRef.current) {
        orphanCancelRef.current();
      }
    };
  }, []);


  const handleSearch = () => {
    manualSearchRef.current = true;
    const sanitized = sanitizeSearchInput(searchInput);
    setSearchValue(sanitized);
    setPage(1);
  };

  const handleSearchClear = () => {
    manualSearchRef.current = true;
    setSearchInput("");
    setSearchValue("");
    setPage(1);
  };

  const handleFilterChange = (newFilter: FilterType) => {
    setFilter(newFilter);
    setPage(1);
  };

  const handleRowClick = async (pkgName: string) => {
    setDetailsLoading(true);
    try {
      const details = await getPackageInfo(pkgName);
      if (!isMountedRef.current) return;
      setSelectedPackage(details);
    } catch (ex) {
      if (!isMountedRef.current) return;
      setError(ex instanceof Error ? ex.message : String(ex));
    } finally {
      if (isMountedRef.current) {
        setDetailsLoading(false);
      }
    }
  };

  const handleRemoveOrphans = () => {
    setOrphanConfirmModalOpen(true);
  };

  const startOrphanRemoval = () => {
    setOrphanConfirmModalOpen(false);
    setOrphanViewState("removing");
    setOrphanLog("");
    setOrphanLogExpanded(true);

    const { cancel } = removeOrphans({
      onData: (data) => setOrphanLog((prev) => {
        const newLog = prev + data;
        return newLog.length > MAX_LOG_SIZE_BYTES ? newLog.slice(-MAX_LOG_SIZE_BYTES) : newLog;
      }),
      onComplete: () => {
        setOrphanViewState("success");
        setOrphanData(null);
        orphanCancelRef.current = null;
      },
      onError: (err) => {
        setOrphanViewState("ready");
        setError(err);
        orphanCancelRef.current = null;
      },
    });
    orphanCancelRef.current = cancel;
  };

  const handleCancelOrphanRemoval = () => {
    if (orphanCancelRef.current) {
      orphanCancelRef.current();
      orphanCancelRef.current = null;
      setOrphanViewState("ready");
      setOrphanLog("");
    }
  };

  const handleOrphanSuccessRefresh = () => {
    setOrphanViewState("ready");
    setOrphanLog("");
    loadPackages();
    loadOrphanCount();
  };

  const filteredAndSortedOrphans = useMemo(() => {
    if (!orphanData?.orphans) return [];
    const searchLower = searchValue.toLowerCase();
    const filtered = searchValue
      ? orphanData.orphans.filter(pkg =>
          pkg.name.toLowerCase().includes(searchLower) ||
          (pkg.description?.toLowerCase().includes(searchLower) ?? false)
        )
      : orphanData.orphans;
    return [...filtered].sort((a, b) => {
      if (activeSortIndex === null) return 0;
      let comparison = 0;
      switch (activeSortIndex) {
        case 0:
          comparison = a.name.localeCompare(b.name);
          break;
        case 2:
          comparison = a.installed_size - b.installed_size;
          break;
        case 3:
          comparison = (a.install_date ?? 0) - (b.install_date ?? 0);
          break;
        default:
          return 0;
      }
      return activeSortDirection === "asc" ? comparison : -comparison;
    });
  }, [orphanData, activeSortIndex, activeSortDirection, searchValue]);

  if (error && packages.length === 0) {
    const isLockError = error?.toLowerCase().includes("unable to lock database");
    return (
      <Card>
        <CardBody>
          <Alert
            variant={isLockError ? "warning" : "danger"}
            title={isLockError ? "Database is locked" : "Error loading packages"}
          >
            {isLockError
              ? "Another package manager operation is in progress. This could be a system upgrade, package installation, or database sync. Please wait for it to complete."
              : error}
          </Alert>
        </CardBody>
      </Card>
    );
  }

  const renderOrphanContent = () => {
    if (orphanViewState === "removing") {
      return (
        <>
          <Flex justifyContent={{ default: "justifyContentSpaceBetween" }} alignItems={{ default: "alignItemsCenter" }} className="pf-v6-u-mb-md">
            <FlexItem>
              <strong>Removing Orphan Packages</strong>
            </FlexItem>
            <FlexItem>
              <Button variant="danger" onClick={handleCancelOrphanRemoval}>
                Cancel
              </Button>
            </FlexItem>
          </Flex>

          <div className="pf-v6-u-mb-md">
            <Spinner size="md" /> Removing packages...
          </div>

          <ExpandableSection
            toggleText={orphanLogExpanded ? "Hide details" : "Show details"}
            onToggle={(_event, expanded) => setOrphanLogExpanded(expanded)}
            isExpanded={orphanLogExpanded}
          >
            <div ref={logContainerRef} style={{ maxHeight: LOG_CONTAINER_HEIGHT, overflow: "auto" }}>
              <CodeBlock>
                <CodeBlockCode>{orphanLog || "Starting..."}</CodeBlockCode>
              </CodeBlock>
            </div>
          </ExpandableSection>
        </>
      );
    }

    if (orphanViewState === "success") {
      return (
        <>
          <EmptyState headingLevel="h2" icon={CheckCircleIcon} titleText="Orphan packages removed">
            <EmptyStateBody>
              All orphan packages have been successfully removed.
            </EmptyStateBody>
            <EmptyStateFooter>
              <EmptyStateActions>
                <Button variant="primary" onClick={handleOrphanSuccessRefresh}>
                  Check Again
                </Button>
              </EmptyStateActions>
            </EmptyStateFooter>
          </EmptyState>
          {orphanLog && (
            <div className="pf-v6-u-mt-md" style={{ maxHeight: LOG_CONTAINER_HEIGHT, overflow: "auto" }}>
              <CodeBlock>
                <CodeBlockCode>{orphanLog}</CodeBlockCode>
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
              <Button variant="secondary" onClick={loadPackages}>
                Refresh
              </Button>
            </EmptyStateActions>
          </EmptyStateFooter>
        </EmptyState>
      );
    }

    return (
      <>
        <Flex justifyContent={{ default: "justifyContentSpaceBetween" }} alignItems={{ default: "alignItemsFlexStart" }} className="pf-v6-u-mb-md">
          <FlexItem>
            <Flex spaceItems={{ default: "spaceItemsLg" }}>
              <FlexItem>
                <StatBox
                  label="Space to Free"
                  value={formatSize(orphanData.total_size)}
                  color="success"
                />
              </FlexItem>
            </Flex>
          </FlexItem>
          <FlexItem>
            <Button
              variant="danger"
              icon={<TrashIcon />}
              onClick={handleRemoveOrphans}
            >
              Remove All Orphans
            </Button>
          </FlexItem>
        </Flex>

        <Table aria-label="Orphan packages" variant="compact">
          <Thead>
            <Tr>
              <Th sort={getSortParams(0)}>Package</Th>
              <Th>Version</Th>
              <Th sort={getSortParams(2)}>Size</Th>
              <Th sort={getSortParams(3)}>Installed</Th>
              <Th>Repository</Th>
            </Tr>
          </Thead>
          <Tbody>
            {filteredAndSortedOrphans.map((pkg: OrphanPackage) => (
              <Tr key={pkg.name} isClickable onRowClick={() => handleRowClick(pkg.name)}>
                <Td dataLabel="Package">
                  <Button variant="link" isInline className="pf-v6-u-p-0">
                    {pkg.name}
                  </Button>
                </Td>
                <Td dataLabel="Version">{pkg.version}</Td>
                <Td dataLabel="Size">{formatSize(pkg.installed_size)}</Td>
                <Td dataLabel="Installed">{formatDate(pkg.install_date)}</Td>
                <Td dataLabel="Repository">
                  <Label color={pkg.repository ? "blue" : "grey"}>
                    {pkg.repository || "user"}
                  </Label>
                </Td>
              </Tr>
            ))}
          </Tbody>
        </Table>
      </>
    );
  };

  const renderPackageContent = () => {
    if (loading && packages.length === 0) {
      return (
        <div className="pf-v6-u-p-xl pf-v6-u-text-align-center">
          <Spinner /> Loading packages...
        </div>
      );
    }

    return (
      <div style={{ position: "relative" }}>
        {loading && (
          <div style={{
            position: "absolute",
            top: 0,
            right: 0,
            padding: "0.5rem",
            zIndex: 1,
          }}>
            <Spinner size="md" />
          </div>
        )}
        <Table aria-label="Installed packages" variant="compact" style={{ opacity: loading ? 0.6 : 1, transition: "opacity 0.2s" }}>
          <Thead>
            <Tr>
              <Th sort={getSortParams(0)}>Name</Th>
              <Th>Version</Th>
              <Th>Description</Th>
              <Th sort={getSortParams(3)}>Size</Th>
              <Th sort={getSortParams(4)}>Reason</Th>
            </Tr>
          </Thead>
          <Tbody>
            {packages.map((pkg) => (
              <Tr
                key={pkg.name}
                isClickable
                onRowClick={() => handleRowClick(pkg.name)}
              >
                <Td dataLabel="Name">
                  <Button variant="link" isInline className="pf-v6-u-p-0">
                    {pkg.name}
                  </Button>
                </Td>
                <Td dataLabel="Version">{pkg.version}</Td>
                <Td dataLabel="Description">{pkg.description || "-"}</Td>
                <Td dataLabel="Size">{formatSize(pkg.installed_size)}</Td>
                <Td dataLabel="Reason">
                  <Label color={pkg.reason === "explicit" ? "blue" : "grey"}>
                    {pkg.reason}
                  </Label>
                </Td>
              </Tr>
            ))}
          </Tbody>
        </Table>
      </div>
    );
  };

  return (
    <Card>
      <CardBody>
        <Toolbar>
          <ToolbarContent>
            {filter !== "graph" && (
              <ToolbarItem>
                <SearchInput
                  placeholder="Search packages..."
                  value={searchInput}
                  onChange={(_event, value) => setSearchInput(value)}
                  onClear={handleSearchClear}
                  onSearch={handleSearch}
                />
              </ToolbarItem>
            )}
            <ToolbarItem>
              <ToggleGroup aria-label="Package filter">
                <ToggleGroupItem
                  text={<>All <Badge isRead>{formatNumber(totalExplicit + totalDependency)}</Badge></>}
                  isSelected={filter === "all"}
                  onChange={() => handleFilterChange("all")}
                />
                <ToggleGroupItem
                  text={<>Explicit <Badge isRead>{formatNumber(totalExplicit)}</Badge></>}
                  isSelected={filter === "explicit"}
                  onChange={() => handleFilterChange("explicit")}
                />
                <ToggleGroupItem
                  text={<>Dependencies <Badge isRead>{formatNumber(totalDependency)}</Badge></>}
                  isSelected={filter === "dependency"}
                  onChange={() => handleFilterChange("dependency")}
                />
                <ToggleGroupItem
                  text={<>Orphans <Badge isRead>{formatNumber(orphanData?.orphans.length ?? 0)}</Badge></>}
                  isSelected={filter === "orphan"}
                  onChange={() => handleFilterChange("orphan")}
                />
                <ToggleGroupItem
                  text={<><TopologyIcon /> Graph</>}
                  isSelected={filter === "graph"}
                  onChange={() => handleFilterChange("graph")}
                />
              </ToggleGroup>
            </ToolbarItem>
            {filter !== "orphan" && filter !== "graph" && (
              <>
                <ToolbarItem>
                  <Select
                    aria-label="Filter by repository"
                    isOpen={repoSelectOpen}
                    selected={repoFilter}
                    onSelect={(_event, value) => {
                      setRepoFilter(value as string);
                      setRepoSelectOpen(false);
                      setPage(1);
                    }}
                    onOpenChange={setRepoSelectOpen}
                    toggle={(toggleRef) => (
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
                      {(repositories || []).map((repo) => (
                        <SelectOption key={repo} value={repo}>
                          {repo}
                        </SelectOption>
                      ))}
                    </SelectList>
                  </Select>
                </ToolbarItem>
                <ToolbarItem variant="pagination" align={{ default: "alignEnd" }}>
                  <Pagination
                    itemCount={total}
                    perPage={perPage}
                    page={page}
                    onSetPage={onSetPage}
                    onPerPageSelect={onPerPageSelect}
                    perPageOptions={PER_PAGE_OPTIONS}
                    isCompact
                  />
                </ToolbarItem>
              </>
            )}
          </ToolbarContent>
        </Toolbar>

        {filter === "graph" ? (
          <DependencyView initialPackage={graphPackage} />
        ) : filter === "orphan" ? (
          loading ? (
            <div className="pf-v6-u-p-xl pf-v6-u-text-align-center">
              <Spinner /> Checking for orphan packages...
            </div>
          ) : (
            renderOrphanContent()
          )
        ) : (
          renderPackageContent()
        )}

        {filter !== "orphan" && filter !== "graph" && (
          <Toolbar>
            <ToolbarContent>
              <ToolbarItem variant="pagination" align={{ default: "alignEnd" }}>
                <Pagination
                  itemCount={total}
                  perPage={perPage}
                  page={page}
                  onSetPage={onSetPage}
                  onPerPageSelect={onPerPageSelect}
                  perPageOptions={PER_PAGE_OPTIONS}
                  isCompact
                />
              </ToolbarItem>
            </ToolbarContent>
          </Toolbar>
        )}

        <PackageDetailsModal
          packageDetails={selectedPackage}
          isLoading={detailsLoading}
          onClose={() => setSelectedPackage(null)}
          onViewDependencies={(packageName) => {
            onGraphPackageChange?.(packageName);
            setFilter("graph");
          }}
        />

        <Modal
          variant={ModalVariant.small}
          isOpen={orphanConfirmModalOpen}
          onClose={() => setOrphanConfirmModalOpen(false)}
        >
          <ModalHeader title="Remove orphan packages?" />
          <ModalBody>
            <Content>
              <Content component={ContentVariants.p}>
                This will remove <strong>{orphanData?.orphans.length ?? 0}</strong> package{(orphanData?.orphans.length ?? 0) !== 1 ? "s" : ""} ({formatSize(orphanData?.total_size ?? 0)}).
              </Content>
              <Content component={ContentVariants.p}>
                Orphan packages are dependencies that are no longer required by any explicitly installed package.
              </Content>
            </Content>
          </ModalBody>
          <ModalFooter>
            <Button key="confirm" variant="danger" onClick={startOrphanRemoval}>
              Remove All
            </Button>
            <Button key="cancel" variant="link" onClick={() => setOrphanConfirmModalOpen(false)}>
              Cancel
            </Button>
          </ModalFooter>
        </Modal>
      </CardBody>
    </Card>
  );
};
