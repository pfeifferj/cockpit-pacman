import React, { useState, useEffect, useLayoutEffect, useCallback, useRef } from "react";
import { useDebouncedValue } from "../hooks/useDebounce";
import { usePackageDetails } from "../hooks/usePackageDetails";
import { usePagination } from "../hooks/usePagination";
import { useSortableTable } from "../hooks/useSortableTable";
import {
  Card,
  CardBody,
  Spinner,
  EmptyState,
  EmptyStateBody,
  EmptyStateFooter,
  EmptyStateActions,
  SearchInput,
  Toolbar,
  ToolbarContent,
  ToolbarItem,
  ToolbarToggleGroup,
  ToolbarFilter,
  ToggleGroup,
  ToggleGroupItem,
  Badge,
  Label,
  MenuToggle,
  Select,
  SelectOption,
  SelectList,
  Button,
  Content,
  ContentVariants,
} from "@patternfly/react-core";
import { CompactPagination } from "./CompactPagination";
import { ErrorAlert } from "./ErrorAlert";
import { LoadErrorState } from "./LoadErrorState";
import { HelpPopover } from "./HelpPopover";
import { TopologyIcon, SearchIcon, FilterIcon } from "@patternfly/react-icons";
import { Table, Thead, Tr, Th, Tbody, Td } from "@patternfly/react-table";
import { DependencyView, type GraphNodeRef, type GraphRequest } from "./DependencyView";
import { OrphansView } from "./OrphansView";
import {
  BackendError,
  type ErrorCode,
  Package,
  PackageListResponse,
  FilterType,
  listInstalled,
  formatSize,
} from "../api";
import { plural, sanitizeSearchInput } from "../utils";
import { PackageDetailsDrawer, DETAILS_TRIGGER_ATTR, detailsRowProps } from "./PackageDetailsDrawer";
import { PackageRowActions, PackageRowActionsProvider, fromRowActions } from "./PackageRowActions";
import { SEARCH_DEBOUNCE_MS } from "../constants";
import { useNavigation } from "../contexts/NavigationContext";
import { useRefreshOnActivate } from "../hooks/useRefreshOnActivate";
import { useResultAnnouncement } from "../contexts/AnnouncerContext";
import { useRouteOptionsSync, type RouteOptions } from "../hooks/useRoute";

const FILTERS: readonly FilterType[] = ["all", "explicit", "dependency", "orphan", "graph"];
const FILTER_CATEGORY = "Show";
const REPO_CATEGORY = "Repository";
const FILTER_CHIP_LABELS: Record<FilterType, string> = {
  all: "All",
  explicit: "Explicit",
  dependency: "Dependencies",
  orphan: "Orphans",
  graph: "Graph",
};

function parseRoute(options: RouteOptions): RouteOptions {
  const graph = options.graph ?? "";
  const filter = graph ? "graph" : FILTERS.includes(options.filter as FilterType) ? options.filter : "all";
  const listed = filter !== "graph" && filter !== "orphan";
  return {
    q: listed ? sanitizeSearchInput(options.q ?? "") : "",
    filter: filter === "all" || graph ? "" : filter,
    graph,
    pkg: options.pkg ?? "",
    repo: options.pkg ? options.repo ?? "" : "",
  };
}

interface DetailsTarget {
  name: string;
  repo?: string;
  /** Sync details even without a repo: a graph node that is not installed. */
  sync?: boolean;
}

interface PackageListProps {
  routeOptions?: RouteOptions;
  onRouteChange?: (options: RouteOptions) => void;
  onSearchRepositories?: (query: string) => void;
}

export const PackageList: React.FC<PackageListProps> = ({ routeOptions, onRouteChange, onSearchRepositories }) => {
  const { onViewHistory } = useNavigation();
  const [initialRoute] = useState(() => parseRoute(routeOptions ?? {}));
  const [packages, setPackages] = useState<Package[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<{ message: string; code?: ErrorCode; details?: string } | null>(null);
  const [searchValue, setSearchValue] = useState(initialRoute.q);
  const [searchInput, setSearchInput] = useState(initialRoute.q);
  const [filter, setFilter] = useState<FilterType>((initialRoute.graph ? "graph" : initialRoute.filter || "all") as FilterType);
  const [graphRequest, setGraphRequest] = useState<GraphRequest | undefined>(
    initialRoute.graph ? { name: initialRoute.graph, seq: 0 } : undefined,
  );
  const graphPackage = graphRequest?.name;
  const [detailsTarget, setDetailsTarget] = useState<DetailsTarget | null>(
    initialRoute.pkg ? { name: initialRoute.pkg, repo: initialRoute.repo || undefined } : null,
  );
  const { selectedPackage, detailsLoading, detailsError, detailsRemoved, detailsErrorCode, detailsErrorContext, fetchDetails, refreshDetails, clearDetails } = usePackageDetails();

  const { page, perPage, total, setPage, setTotal, onSetPage, onPerPageSelect } = usePagination();
  const [totalExplicit, setTotalExplicit] = useState(0);
  const [totalDependency, setTotalDependency] = useState(0);
  const [repositories, setRepositories] = useState<string[]>([]);
  const [repoFilter, setRepoFilter] = useState("all");
  const [repoSelectOpen, setRepoSelectOpen] = useState(false);
  const manualSearchRef = useRef(false);
  const isMountedRef = useRef(true);
  const searchInputRef = useRef<HTMLInputElement>(null);
  const filterToggleRef = useRef<ToolbarToggleGroup>(null);
  const focusSearchPendingRef = useRef(false);
  // PatternFly hardcodes the collapsed toggle's name as "Show Filters".
  useLayoutEffect(() => {
    filterToggleRef.current?.toggleRef.current?.setAttribute("aria-label", "Show filters");
  });
  // A removed chip unmounts with its filter; the search input may only mount on the next render.
  useEffect(() => {
    if (focusSearchPendingRef.current && searchInputRef.current) {
      focusSearchPendingRef.current = false;
      searchInputRef.current.focus();
    }
  });
  const searchValueRef = useRef(searchValue);
  useEffect(() => {
    searchValueRef.current = searchValue;
  });

  const [orphanCount, setOrphanCount] = useState(0);
  const [resultKey, setResultKey] = useState("|all|all");
  const requestRef = useRef(0);

  const { activeSortIndex, activeSortDirection, getSortParams, resetSort } = useSortableTable({
    sortableColumns: [0, 3, 4],
    defaultDirection: "asc",
    onSort: () => setPage(1),
  });

  useEffect(() => {
    isMountedRef.current = true;
    return () => {
      isMountedRef.current = false;
    };
  }, []);

  useEffect(() => {
    if (detailsTarget) {
      fetchDetails(detailsTarget.name, detailsTarget.repo || detailsTarget.sync
        ? { strategy: "sync", repo: detailsTarget.repo }
        : { strategy: "local" });
    } else {
      clearDetails();
    }
  }, [detailsTarget, fetchDetails, clearDetails]);

  useRouteOptionsSync(
    routeOptions,
    onRouteChange,
    {
      q: filter === "graph" || filter === "orphan" ? "" : searchValue,
      filter: filter === "all" || (filter === "graph" && graphPackage) ? "" : filter,
      graph: filter === "graph" ? graphPackage : "",
      pkg: detailsTarget?.name,
      repo: detailsTarget?.repo,
    },
    parseRoute,
    (options) => {
      const nextFilter = (options.graph ? "graph" : options.filter || "all") as FilterType;
      if (options.q !== searchValueRef.current) {
        manualSearchRef.current = true;
        setSearchInput(options.q);
        setSearchValue(options.q);
        setRepoFilter("all");
        setPage(1);
        if (nextFilter !== "graph" && nextFilter !== "orphan") searchInputRef.current?.focus();
      }
      if (nextFilter !== filter) {
        setFilter(nextFilter);
        setPage(1);
      }
      const graph = options.graph;
      if (graph) setGraphRequest((current) => (current?.name === graph ? current : { name: graph, seq: (current?.seq ?? 0) + 1 }));
      const target = detailsTarget ? `${detailsTarget.name}|${detailsTarget.repo ?? ""}` : "|";
      if (`${options.pkg}|${options.repo}` !== target) {
        setDetailsTarget(options.pkg ? { name: options.pkg, repo: options.repo || undefined } : null);
      }
    },
  );

  const debouncedSearchInput = useDebouncedValue(
    sanitizeSearchInput(searchInput),
    SEARCH_DEBOUNCE_MS
  );

  useEffect(() => {
    if (manualSearchRef.current) {
      manualSearchRef.current = false;
      return;
    }
    if (debouncedSearchInput === searchValue) return;
    Promise.resolve().then(() => {
      setSearchValue(debouncedSearchInput);
      setPage(1);
    });
  }, [debouncedSearchInput, searchValue, setPage]);

  const getSortField = (index: number | null): string => {
    if (index === null) return "";
    switch (index) {
      case 0: return "name";
      case 3: return "size";
      case 4: return "reason";
      default: return "";
    }
  };

  const loadPackages = useCallback(async () => {
    if (filter === "graph" || filter === "orphan") {
      setLoading(false);
      return;
    }
    const request = ++requestRef.current;
    setLoading(true);
    setError(null);
    try {
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
      if (!isMountedRef.current || request !== requestRef.current) return;
      setPackages(response.packages);
      setTotal(response.total);
      setTotalExplicit(response.total_explicit);
      setTotalDependency(response.total_dependency);
      setRepositories(response.repositories || []);
      setResultKey(`${searchValue}|${filter}|${repoFilter}`);
    } catch (ex) {
      if (!isMountedRef.current || request !== requestRef.current) return;
      setError({
        message: ex instanceof Error ? ex.message : String(ex),
        code: ex instanceof BackendError ? ex.code : undefined,
        details: ex instanceof BackendError ? ex.details : undefined,
      });
    } finally {
      if (isMountedRef.current && request === requestRef.current) {
        setLoading(false);
      }
    }
  }, [page, perPage, searchValue, filter, repoFilter, activeSortIndex, activeSortDirection, setTotal]);

  useEffect(() => {
    Promise.resolve().then(() => loadPackages());
  }, [loadPackages]);

  useRefreshOnActivate(() => {
    loadPackages();
    void refreshDetails();
  });

  // An Undo toast can outlive the render that offered Mark, so reload with the current filter and page.
  const loadPackagesRef = useRef(loadPackages);
  useEffect(() => {
    loadPackagesRef.current = loadPackages;
  });
  const reloadAfterReasonChange = useCallback(() => {
    loadPackagesRef.current();
    void refreshDetails();
  }, [refreshDetails]);

  useResultAnnouncement(
    loading || error
      ? null
      : total === 0
        ? "No installed packages match"
        : plural(total, "package"),
    resultKey,
  );

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

  const handleResetFilters = () => {
    // The debounce effect consumes this flag only when searchValue changes.
    if (searchValue !== "") manualSearchRef.current = true;
    setSearchInput("");
    setSearchValue("");
    setFilter("all");
    setRepoFilter("all");
    setPage(1);
    resetSort();
    searchInputRef.current?.focus();
  };

  const handleFilterChange = (newFilter: FilterType) => {
    setFilter(newFilter);
    setPage(1);
  };

  const clearChipFilter = (category: string) => {
    if (category === FILTER_CATEGORY) handleFilterChange("all");
    else {
      setRepoFilter("all");
      setPage(1);
    }
    focusSearchPendingRef.current = true;
  };

  const clearChipFilters = () => {
    setFilter("all");
    setRepoFilter("all");
    setPage(1);
    focusSearchPendingRef.current = true;
  };

  const filterChip = filter !== "all" ? [FILTER_CHIP_LABELS[filter]] : [];
  const repoChip = repoFilter !== "all" && filter !== "orphan" && filter !== "graph" ? [repoFilter] : [];

  const handleRowClick = (pkgName: string) => {
    setDetailsTarget((current) => (current?.name === pkgName && !current.repo && !current.sync ? current : { name: pkgName }));
  };

  const viewDependencies = (packageName: string) => {
    setGraphRequest((current) => ({ name: packageName, seq: (current?.seq ?? 0) + 1 }));
    setFilter("graph");
  };

  const handleGraphDetails = (node: GraphNodeRef) => {
    if (node.installed) {
      handleRowClick(node.name);
      return;
    }
    setDetailsTarget((current) => (current?.name === node.name && current.sync
      ? current
      : { name: node.name, repo: node.repository ?? undefined, sync: true }));
  };

  const shownDetailsError = detailsTarget?.sync && detailsError && detailsErrorCode === "not_found"
    ? `${detailsTarget.name} is not in any configured repository`
    : detailsError;

  const renderLoadError = (title: string) => {
    if (!error) return null;
    return (
      <ErrorAlert
        error={error.message}
        code={error.code}
        details={error.details}
        title={title}
        isInline
        className="pf-v6-u-mb-md"
        onRetry={() => loadPackages()}
        showRetry
      />
    );
  };

  if (error && filter !== "orphan" && filter !== "graph" && packages.length === 0) {
    return (
      <Card>
        <CardBody>
          <LoadErrorState
            what="installed packages"
            error={error.message}
            code={error.code}
            details={error.details}
            onRetry={() => loadPackages()}
          />
        </CardBody>
      </Card>
    );
  }

  const renderPackageContent = () => {
    if (loading && packages.length === 0) {
      return (
        <EmptyState headingLevel="h2" icon={Spinner} titleText="Loading packages">
          <EmptyStateBody>Fetching installed package list…</EmptyStateBody>
        </EmptyState>
      );
    }

    if (!loading && packages.length === 0) {
      const narrowed = searchValue !== "" || filter !== "all" || repoFilter !== "all";
      return (
        <EmptyState
          headingLevel="h3"
          icon={SearchIcon}
          titleText={narrowed ? "No installed packages match" : "No installed packages"}
        >
          {narrowed && (
            <EmptyStateFooter>
              <EmptyStateActions>
                <Button variant="primary" onClick={handleResetFilters}>
                  Clear search and filters
                </Button>
                {searchValue !== "" && onSearchRepositories && (
                  <Button variant="secondary" onClick={() => onSearchRepositories(searchValue)}>
                    Search the repositories for {searchValue}
                  </Button>
                )}
              </EmptyStateActions>
            </EmptyStateFooter>
          )}
        </EmptyState>
      );
    }

    return (
      <div style={{ position: "relative" }}>
        {renderLoadError("Could not refresh installed packages")}
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
              <Th screenReaderText="Actions" />
            </Tr>
          </Thead>
          <Tbody>
            {packages.map((pkg) => (
              <Tr
                key={pkg.name}
                isClickable
                onRowClick={(event) => !fromRowActions(event) && handleRowClick(pkg.name)}
                {...detailsRowProps(detailsTarget?.name === pkg.name)}
              >
                <Td dataLabel="Name">
                  <Button variant="link" isInline className="pf-v6-u-p-0" {...{ [DETAILS_TRIGGER_ATTR]: pkg.name }}>
                    {pkg.name}
                  </Button>
                </Td>
                <Td dataLabel="Version"><Label isCompact variant="outline">{pkg.version}</Label></Td>
                <Td dataLabel="Description">{pkg.description || "-"}</Td>
                <Td dataLabel="Size">{formatSize(pkg.installed_size)}</Td>
                <Td dataLabel="Reason">
                  <Label color={pkg.reason === "explicit" ? "blue" : "grey"}>
                    {pkg.reason}
                  </Label>
                </Td>
                <Td isActionCell>
                  <PackageRowActions
                    name={pkg.name}
                    installedVersion={pkg.version}
                    repository={pkg.repository}
                    reason={pkg.reason}
                    onViewDetails={() => handleRowClick(pkg.name)}
                    onViewDependencies={viewDependencies}
                    onReasonChange={reloadAfterReasonChange}
                  />
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
        <Toolbar
          clearAllFilters={clearChipFilters}
          clearFiltersButtonText="Clear filters"
          numberOfFiltersText={() => `Showing ${[...filterChip, ...repoChip].join(", ")}`}
        >
          <ToolbarContent>
            {filter !== "graph" && filter !== "orphan" && (
              <ToolbarItem>
                <SearchInput
                  ref={searchInputRef}
                  placeholder="Search installed packages, e.g. python-"
                  aria-label="Search installed packages"
                  value={searchInput}
                  onChange={(_event, value) => setSearchInput(value)}
                  onClear={handleSearchClear}
                  onSearch={handleSearch}
                />
              </ToolbarItem>
            )}
            <ToolbarToggleGroup ref={filterToggleRef} toggleIcon={<FilterIcon />} breakpoint="lg">
              <ToolbarFilter
                labels={filterChip}
                deleteLabel={(category) => clearChipFilter(String(category))}
                categoryName={FILTER_CATEGORY}
              >
                <ToggleGroup aria-label="Package filter">
                  <ToggleGroupItem
                    text={<>All <Badge isRead>{(totalExplicit + totalDependency).toLocaleString()}</Badge></>}
                    isSelected={filter === "all"}
                    onChange={() => handleFilterChange("all")}
                  />
                  <ToggleGroupItem
                    text={<>Explicit <Badge isRead>{(totalExplicit).toLocaleString()}</Badge></>}
                    isSelected={filter === "explicit"}
                    onChange={() => handleFilterChange("explicit")}
                  />
                  <ToggleGroupItem
                    text={<>Dependencies <Badge isRead>{(totalDependency).toLocaleString()}</Badge></>}
                    isSelected={filter === "dependency"}
                    onChange={() => handleFilterChange("dependency")}
                  />
                  <ToggleGroupItem
                    text={<>Orphans <Badge isRead>{(orphanCount).toLocaleString()}</Badge></>}
                    isSelected={filter === "orphan"}
                    onChange={() => handleFilterChange("orphan")}
                  />
                  <ToggleGroupItem
                    text={<><TopologyIcon /> Graph</>}
                    isSelected={filter === "graph"}
                    onChange={() => handleFilterChange("graph")}
                  />
                </ToggleGroup>{" "}
                <HelpPopover
                  label="package filters"
                  header="Package filters"
                  body={
                    <Content component={ContentVariants.dl}>
                      <Content component={ContentVariants.dt}>Explicit</Content>
                      <Content component={ContentVariants.dd}>
                        Packages whose install reason is explicit. Includes anything installed directly with <code>pacman -S</code>, <code>pacman -U</code> (local .pkg.tar.zst files from makepkg or AUR helpers), and packages later marked explicit with &quot;Mark <em>package</em> as explicitly installed&quot; in their row&apos;s actions menu or their details (<code>pacman -D --asexplicit</code>).
                      </Content>
                      <Content component={ContentVariants.dt}>Dependencies</Content>
                      <Content component={ContentVariants.dd}>
                        Packages installed automatically to satisfy another package&apos;s requirements.
                      </Content>
                      <Content component={ContentVariants.dt}>Orphans</Content>
                      <Content component={ContentVariants.dd}>
                        Packages installed as dependencies that are no longer required by any other package.
                      </Content>
                    </Content>
                  }
                />
              </ToolbarFilter>
              <ToolbarFilter
                labels={repoChip}
                deleteLabel={(category) => clearChipFilter(String(category))}
                categoryName={REPO_CATEGORY}
                showToolbarItem={filter !== "orphan" && filter !== "graph"}
              >
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
              </ToolbarFilter>
            </ToolbarToggleGroup>
            {filter !== "orphan" && filter !== "graph" && (
              <ToolbarItem variant="pagination" align={{ default: "alignEnd" }}>
                <CompactPagination
                  itemCount={total}
                  perPage={perPage}
                  page={page}
                  onSetPage={onSetPage}
                  onPerPageSelect={onPerPageSelect}
                />
              </ToolbarItem>
            )}
          </ToolbarContent>
        </Toolbar>

        <PackageRowActionsProvider>
        <PackageDetailsDrawer
          activeKey={detailsTarget?.name ?? null}
          packageDetails={selectedPackage}
          isLoading={detailsLoading}
          onClose={() => setDetailsTarget(null)}
          error={shownDetailsError}
          errorCode={detailsErrorCode}
          errorDetails={detailsErrorContext}
          isRemoved={detailsRemoved}
          onViewDependencies={viewDependencies}
          onViewHistory={onViewHistory}
        >
        {filter === "graph" ? (
          <DependencyView
            request={graphRequest}
            onShowDetails={handleGraphDetails}
            detailsOpen={selectedPackage !== null || detailsLoading || !!detailsError}
          />
        ) : filter === "orphan" ? (
          <OrphansView
            onRowClick={handleRowClick}
            onOrphansLoaded={setOrphanCount}
            onViewDependencies={viewDependencies}
          />
        ) : (
          renderPackageContent()
        )}

        {filter !== "orphan" && filter !== "graph" && (
          <Toolbar>
            <ToolbarContent>
              <ToolbarItem variant="pagination" align={{ default: "alignEnd" }}>
                <CompactPagination
                  itemCount={total}
                  perPage={perPage}
                  page={page}
                  onSetPage={onSetPage}
                  onPerPageSelect={onPerPageSelect}
                />
              </ToolbarItem>
            </ToolbarContent>
          </Toolbar>
        )}
        </PackageDetailsDrawer>
        </PackageRowActionsProvider>
      </CardBody>
    </Card>
  );
};
