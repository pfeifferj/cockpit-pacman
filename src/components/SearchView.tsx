import React, { useState, useEffect, useLayoutEffect, useRef } from "react";
import { usePackageDetails } from "../hooks/usePackageDetails";
import { usePagination } from "../hooks/usePagination";
import { useSortableTable } from "../hooks/useSortableTable";
import {
  Card,
  CardBody,
  SearchInput,
  Toolbar,
  ToolbarContent,
  ToolbarItem,
  ToolbarToggleGroup,
  ToolbarFilter,
  Label,
  EmptyState,
  EmptyStateBody,
  EmptyStateFooter,
  EmptyStateActions,
  MenuToggle,
  MenuToggleElement,
  Select,
  SelectOption,
  SelectList,
  ToggleGroup,
  ToggleGroupItem,
  Badge,
  Button,
  Spinner,
  Alert,
  AlertActionLink,
} from "@patternfly/react-core";
import { CompactPagination } from "./CompactPagination";
import { ErrorAlert } from "./ErrorAlert";
import { SearchIcon, FilterIcon } from "@patternfly/react-icons";
import { Table, Thead, Tr, Th, Tbody, Td } from "@patternfly/react-table";
import { BackendError, SearchResult, searchPackages, InstalledFilterType, type RepositoryCount, type ErrorCode } from "../api";
import { plural, REPO_NAME_RE, sanitizeErrorMessage, sanitizeSearchInput } from "../utils";
import { PackageDetailsDrawer, DETAILS_TRIGGER_ATTR, detailsRowProps } from "./PackageDetailsDrawer";
import { PackageRowActions, PackageRowActionsProvider, fromRowActions } from "./PackageRowActions";
import { SEARCH_DEBOUNCE_MS } from "../constants";
import { useRefreshOnActivate } from "../hooks/useRefreshOnActivate";
import { useResultAnnouncement } from "../contexts/AnnouncerContext";
import { useRouteOptionsSync, type RouteOptions } from "../hooks/useRoute";

const MIN_SEARCH_LENGTH = 1;
const INSTALLED_CATEGORY = "Show";
const REPO_CATEGORY = "Repository";
const INSTALLED_FILTER_LABELS: Record<InstalledFilterType, string> = {
  all: "All",
  installed: "Installed",
  "not-installed": "Not installed",
};

function parseRoute(options: RouteOptions): RouteOptions {
  const repoFilter = options.in ?? "";
  return {
    q: sanitizeSearchInput(options.q ?? ""),
    in: REPO_NAME_RE.test(repoFilter) && repoFilter !== "all" ? repoFilter : "",
    pkg: options.pkg ?? "",
    repo: options.pkg ? options.repo ?? "" : "",
  };
}

function opensSyncDetails(pkg: SearchResult): boolean {
  return !pkg.installed || pkg.installed_version !== pkg.version || pkg.repository.endsWith("-testing");
}

function refusedRepo(err: unknown, repo: string): string | null {
  return err instanceof BackendError && err.code === "validation_error" && repo !== "all" ? repo : null;
}

interface DetailsTarget {
  name: string;
  repo?: string;
}

interface SearchViewProps {
  routeOptions?: RouteOptions;
  onRouteChange?: (options: RouteOptions) => void;
  onSearchInstalled?: (query: string) => void;
}

export const SearchView: React.FC<SearchViewProps> = ({ routeOptions, onRouteChange, onSearchInstalled }) => {
  const [initialRoute] = useState(() => parseRoute(routeOptions ?? {}));
  const [results, setResults] = useState<SearchResult[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [errorCode, setErrorCode] = useState<ErrorCode | undefined>();
  const [errorDetails, setErrorDetails] = useState<string | undefined>();
  const [unknownRepo, setUnknownRepo] = useState<string | null>(null);
  const [searchInput, setSearchInput] = useState(initialRoute.q);
  const [currentQuery, setCurrentQuery] = useState("");
  const [hasSearched, setHasSearched] = useState(false);
  const [repoFilter, setRepoFilter] = useState(initialRoute.in || "all");
  const [repoSelectOpen, setRepoSelectOpen] = useState(false);
  const [installedFilter, setInstalledFilter] = useState<InstalledFilterType>("all");
  const [resultKey, setResultKey] = useState<string | null>(null);
  const { selectedPackage, detailsLoading, detailsError, detailsRemoved, detailsErrorCode, detailsErrorContext, fetchDetails, refreshDetails, clearDetails } = usePackageDetails();
  const [detailsTarget, setDetailsTarget] = useState<DetailsTarget | null>(
    initialRoute.pkg ? { name: initialRoute.pkg, repo: initialRoute.repo || undefined } : null,
  );
  const [openRowKey, setOpenRowKey] = useState<string | null>(null);
  const { page, perPage, total, setPage, setPerPage, setTotal } = usePagination();
  const [totalInstalled, setTotalInstalled] = useState(0);
  const [totalNotInstalled, setTotalNotInstalled] = useState(0);
  const [repositoryCounts, setRepositoryCounts] = useState<RepositoryCount[]>([]);
  const pendingRepoRef = useRef(initialRoute.in);
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const currentQueryRef = useRef(currentQuery);
  const abortControllerRef = useRef<AbortController | null>(null);
  const searchInputRef = useRef<HTMLInputElement>(null);
  const filterToggleRef = useRef<ToolbarToggleGroup>(null);
  // PatternFly hardcodes the collapsed toggle's name as "Show Filters".
  useLayoutEffect(() => {
    filterToggleRef.current?.toggleRef.current?.setAttribute("aria-label", "Show filters");
  });

  const { activeSortIndex, activeSortDirection, setActiveSortIndex, getSortParams } = useSortableTable({
    sortableColumns: [0, 3, 4], // name, repository, status
    defaultDirection: "asc",
    onSort: (index: number, direction: "asc" | "desc") => {
      setPage(1);
      if (currentQuery) {
        fetchResults(currentQuery, 1, perPage, installedFilter, repoFilter, false, index, direction);
      }
    },
  });

  useEffect(() => {
    return () => {
      abortControllerRef.current?.abort();
    };
  }, []);

  const perPageRef = useRef(perPage);
  const installedFilterRef = useRef(installedFilter);
  // The debounced setTimeout below reads these after the effect has captured stale state;
  // sync the refs after every commit so it sees the latest values.
  useEffect(() => {
    currentQueryRef.current = currentQuery;
    perPageRef.current = perPage;
    installedFilterRef.current = installedFilter;
  });

  useEffect(() => {
    if (detailsTarget) {
      fetchDetails(detailsTarget.name, detailsTarget.repo ? { strategy: "sync", repo: detailsTarget.repo } : { strategy: "local-then-sync" });
    } else {
      clearDetails();
    }
  }, [detailsTarget, fetchDetails, clearDetails]);

  // Debounced auto-search when input changes
  useEffect(() => {
    if (debounceRef.current) {
      clearTimeout(debounceRef.current);
    }

    // Abort any in-flight request
    abortControllerRef.current?.abort();

    const query = sanitizeSearchInput(searchInput);
    if (query.length < MIN_SEARCH_LENGTH) {
      // The abort above skipped that request's setLoading(false).
      debounceRef.current = setTimeout(() => setLoading(false), 0);
      return;
    }

    debounceRef.current = setTimeout(async () => {
      // Create new AbortController for this request
      abortControllerRef.current = new AbortController();
      const currentController = abortControllerRef.current;

      if (query !== currentQueryRef.current) {
        const repo = pendingRepoRef.current || "all";
        pendingRepoRef.current = "";
        setCurrentQuery(query);
        setHasSearched(true);
        setRepoFilter(repo);
        setInstalledFilter("all");
        setPage(1);
        setActiveSortIndex(null);
        setResultKey(null);
        setLoading(true);
        setError(null);
        setErrorCode(undefined);
        setErrorDetails(undefined);
        try {
          const response = await searchPackages({
            signal: currentController.signal,
            query,
            offset: 0,
            limit: perPageRef.current,
            installed: "all",
            repo,
          });
          if (currentController.signal.aborted) return;
          setResults(response.results);
          setTotal(response.total);
          setTotalInstalled(response.total_installed);
          setTotalNotInstalled(response.total_not_installed);
          setRepositoryCounts(response.repository_counts ?? []);
          setResultKey(`${query}|all|${repo}`);
        } catch (ex) {
          if (currentController.signal.aborted) return;
          setError(ex instanceof Error ? ex.message : String(ex));
          setErrorCode(ex instanceof BackendError ? ex.code : undefined);
          setErrorDetails(ex instanceof BackendError ? ex.details : undefined);
          setUnknownRepo(refusedRepo(ex, repo));
          setResults([]);
          setTotal(0);
          setTotalInstalled(0);
          setTotalNotInstalled(0);
          setRepositoryCounts([]);
        } finally {
          if (!currentController.signal.aborted) {
            setLoading(false);
          }
        }
      }
    }, SEARCH_DEBOUNCE_MS);

    return () => {
      if (debounceRef.current) {
        clearTimeout(debounceRef.current);
      }
      abortControllerRef.current?.abort();
    };
  }, [searchInput, setActiveSortIndex, setPage, setTotal]);

  const getSortField = (index: number | null): string => {
    if (index === null) return "";
    switch (index) {
      case 0: return "name";
      case 3: return "repository";
      case 4: return "status";
      default: return "";
    }
  };

  const fetchResults = async (query: string, pageNum: number, pageSize: number, installed: InstalledFilterType, repo: string, updateRepos = false, sortIdx: number | null = null, sortDirection: "asc" | "desc" = "asc") => {
    abortControllerRef.current?.abort();
    abortControllerRef.current = new AbortController();
    const currentController = abortControllerRef.current;
    setLoading(true);
    setError(null);
    setErrorCode(undefined);
    setErrorDetails(undefined);
    try {
      const offset = (pageNum - 1) * pageSize;
      const response = await searchPackages({
        signal: currentController.signal,
        query,
        offset,
        limit: pageSize,
        installed,
        sortBy: getSortField(sortIdx),
        sortDir: sortDirection,
        repo,
      });
      if (currentController.signal.aborted) return;
      setResults(response.results);
      setTotal(response.total);
      setTotalInstalled(response.total_installed);
      setTotalNotInstalled(response.total_not_installed);
      setRepositoryCounts(response.repository_counts ?? []);
      setResultKey(`${query}|${installed}|${repo}`);
    } catch (ex) {
      if (currentController.signal.aborted) return;
      setError(ex instanceof Error ? ex.message : String(ex));
      setErrorCode(ex instanceof BackendError ? ex.code : undefined);
      setErrorDetails(ex instanceof BackendError ? ex.details : undefined);
      setUnknownRepo(refusedRepo(ex, repo));
      setResults([]);
      setTotal(0);
      setTotalInstalled(0);
      setTotalNotInstalled(0);
      if (updateRepos) {
        setRepositoryCounts([]);
      }
    } finally {
      if (!currentController.signal.aborted) {
        setLoading(false);
      }
    }
  };

  useRefreshOnActivate(() => {
    if (currentQuery) {
      fetchResults(currentQuery, page, perPage, installedFilter, repoFilter, true, activeSortIndex, activeSortDirection);
    }
    void refreshDetails();
  }, { kinds: ["system", "sync"] });

  const handleSearch = async () => {
    // Cancel any pending debounce when manually searching
    if (debounceRef.current) {
      clearTimeout(debounceRef.current);
    }

    const query = sanitizeSearchInput(searchInput);
    if (query.length < MIN_SEARCH_LENGTH) {
      setError(`Search query must be at least ${MIN_SEARCH_LENGTH} characters`);
      setErrorCode("validation_error");
      setErrorDetails(undefined);
      setUnknownRepo(null);
      return;
    }

    setCurrentQuery(query);
    setHasSearched(true);
    setRepoFilter("all");
    setInstalledFilter("all");
    setPage(1);
    setActiveSortIndex(null);
    setResultKey(null);
    await fetchResults(query, 1, perPage, "all", "all", true);
  };

  const handleSearchClear = () => {
    // Cancel any pending debounce when clearing
    if (debounceRef.current) {
      clearTimeout(debounceRef.current);
    }

    setSearchInput("");
    setCurrentQuery("");
    setResults([]);
    setError(null);
    setErrorCode(undefined);
    setErrorDetails(undefined);
    setHasSearched(false);
    setRepoFilter("all");
    setInstalledFilter("all");
    setPage(1);
    setTotal(0);
    setRepositoryCounts([]);
    setActiveSortIndex(null);
    setResultKey(null);
  };

  const handleSetPage = (_event: React.MouseEvent | React.KeyboardEvent | MouseEvent, newPage: number) => {
    setPage(newPage);
    if (currentQuery) {
      fetchResults(currentQuery, newPage, perPage, installedFilter, repoFilter, false, activeSortIndex, activeSortDirection);
    }
  };

  const handlePerPageSelect = (_event: React.MouseEvent | React.KeyboardEvent | MouseEvent, newPerPage: number) => {
    setPerPage(newPerPage);
    setPage(1);
    if (currentQuery) {
      fetchResults(currentQuery, 1, newPerPage, installedFilter, repoFilter, false, activeSortIndex, activeSortDirection);
    }
  };

  const handleInstalledFilterChange = (value: InstalledFilterType) => {
    setInstalledFilter(value);
    setPage(1);
    if (currentQuery) {
      fetchResults(currentQuery, 1, perPage, value, repoFilter, false, activeSortIndex, activeSortDirection);
    }
  };

  const handleRepoFilterChange = (value: string) => {
    setRepoFilter(value);
    setPage(1);
    if (currentQuery) {
      fetchResults(currentQuery, 1, perPage, installedFilter, value, false, activeSortIndex, activeSortDirection);
    }
  };

  const handleClearRepoFilter = () => {
    handleRepoFilterChange("all");
    searchInputRef.current?.focus();
  };

  const handleShowAllResults = () => {
    handleInstalledFilterChange("all");
    searchInputRef.current?.focus();
  };

  const handleClearChipFilters = () => {
    setInstalledFilter("all");
    setRepoFilter("all");
    setPage(1);
    if (currentQuery) {
      fetchResults(currentQuery, 1, perPage, "all", "all", false, activeSortIndex, activeSortDirection);
    }
    searchInputRef.current?.focus();
  };

  const installedChip = installedFilter !== "all" ? [INSTALLED_FILTER_LABELS[installedFilter]] : [];
  const repoChip = repoFilter !== "all" ? [repoFilter] : [];

  const repoOptions = repoFilter !== "all" && !repositoryCounts.some((c) => c.name === repoFilter)
    ? [...repositoryCounts, { name: repoFilter, count: 0 }]
    : repositoryCounts;
  const allReposCount = repositoryCounts.reduce((sum, c) => sum + c.count, 0);
  const inOtherRepos = allReposCount - (repositoryCounts.find((c) => c.name === repoFilter)?.count ?? 0);

  const inRepo = repoFilter === "all" ? "" : ` in ${repoFilter}`;
  const resultMessage = loading || error
    ? null
    : results.length === 0
      ? `No packages found for ${currentQuery}${inRepo}`
      : `${plural(total, "package")} found${inRepo}`;
  useResultAnnouncement(resultMessage, resultKey);

  useRouteOptionsSync(
    routeOptions,
    onRouteChange,
    { q: currentQuery, in: repoFilter === "all" ? "" : repoFilter, pkg: detailsTarget?.name, repo: detailsTarget?.repo },
    parseRoute,
    (options) => {
      if (options.q !== currentQueryRef.current) {
        if (options.q === "") {
          handleSearchClear();
        } else {
          pendingRepoRef.current = options.in;
          setSearchInput(options.q);
        }
        searchInputRef.current?.focus();
      } else if ((options.in || "all") !== repoFilter) {
        handleRepoFilterChange(options.in || "all");
      }
      const target = detailsTarget ? `${detailsTarget.name}|${detailsTarget.repo ?? ""}` : "|";
      if (`${options.pkg}|${options.repo}` !== target) {
        setDetailsTarget(options.pkg ? { name: options.pkg, repo: options.repo || undefined } : null);
      }
    },
  );

  const rowKey = (pkg: SearchResult) => `${pkg.repository}/${pkg.name}`;
  const handleRowClick = (pkg: SearchResult) => {
    const next: DetailsTarget = opensSyncDetails(pkg) ? { name: pkg.name, repo: pkg.repository } : { name: pkg.name };
    setOpenRowKey(rowKey(pkg));
    setDetailsTarget((current) => (current?.name === next.name && current.repo === next.repo ? current : next));
  };

  const closeDetails = () => {
    setOpenRowKey(null);
    setDetailsTarget(null);
  };

  const activeRowKey = !detailsTarget
    ? null
    : openRowKey?.split("/")[1] === detailsTarget.name
      ? openRowKey
      : (() => {
        const row = results.find((pkg) =>
          pkg.name === detailsTarget.name && (detailsTarget.repo ? pkg.repository === detailsTarget.repo : !opensSyncDetails(pkg)));
        return row ? rowKey(row) : null;
      })();

  const retrySearch = () =>
    fetchResults(currentQuery, page, perPage, installedFilter, repoFilter, true, activeSortIndex, activeSortDirection);

  const errorAlert = error && unknownRepo !== null && unknownRepo === repoFilter ? (
    <Alert
      variant="danger"
      title="Search failed"
      className="pf-v6-u-mb-md"
      actionLinks={<AlertActionLink onClick={handleClearRepoFilter}>Search all repositories</AlertActionLink>}
    >
      {sanitizeErrorMessage(error)}
    </Alert>
  ) : error ? (
    <ErrorAlert
      error={error}
      code={errorCode}
      details={errorDetails}
      title="Search failed"
      lockMessage="Another package manager operation is in progress. Please wait for it to complete before searching."
      onRetry={currentQuery ? retrySearch : undefined}
      className="pf-v6-u-mb-md"
    />
  ) : null;

  return (
    <>
      {errorAlert}
      <Card>
      <CardBody>
        <Toolbar
          clearAllFilters={handleClearChipFilters}
          clearFiltersButtonText="Clear filters"
          numberOfFiltersText={() => `Showing ${[...installedChip, ...repoChip].join(", ")}`}
        >
          <ToolbarContent>
            <ToolbarItem >
              <SearchInput
                ref={searchInputRef}
                placeholder="Search Arch repositories, e.g. linux-lts, python-requests"
                aria-label="Search Arch repositories"
                value={searchInput}
                onChange={(_event: React.SyntheticEvent, value: string) => setSearchInput(value)}
                onClear={handleSearchClear}
                onSearch={handleSearch}
              />
            </ToolbarItem>
            {(hasSearched || repoOptions.length > 0) && (
            <ToolbarToggleGroup ref={filterToggleRef} toggleIcon={<FilterIcon />} breakpoint="lg">
              <ToolbarFilter
                labels={installedChip}
                deleteLabel={handleShowAllResults}
                categoryName={INSTALLED_CATEGORY}
                showToolbarItem={hasSearched}
              >
                <ToggleGroup aria-label="Installed filter">
                  <ToggleGroupItem
                    text={<>All <Badge isRead>{totalInstalled + totalNotInstalled}</Badge></>}
                    isSelected={installedFilter === "all"}
                    onChange={() => handleInstalledFilterChange("all")}
                  />
                  <ToggleGroupItem
                    text={<>Installed <Badge isRead>{totalInstalled}</Badge></>}
                    isSelected={installedFilter === "installed"}
                    onChange={() => handleInstalledFilterChange("installed")}
                  />
                  <ToggleGroupItem
                    text={<>Not installed <Badge isRead>{totalNotInstalled}</Badge></>}
                    isSelected={installedFilter === "not-installed"}
                    onChange={() => handleInstalledFilterChange("not-installed")}
                  />
                </ToggleGroup>
              </ToolbarFilter>
              <ToolbarFilter
                labels={repoChip}
                deleteLabel={handleClearRepoFilter}
                categoryName={REPO_CATEGORY}
                showToolbarItem={repoOptions.length > 0}
              >
                <Select
                  aria-label="Filter by repository"
                  isOpen={repoSelectOpen}
                  selected={repoFilter}
                  onSelect={(_event: React.MouseEvent | undefined, value: string | number | undefined) => {
                    setRepoSelectOpen(false);
                    if (value !== repoFilter) handleRepoFilterChange(value as string);
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
                    <SelectOption value="all">All repositories ({allReposCount.toLocaleString()})</SelectOption>
                    {repoOptions.map(({ name, count }) => (
                      <SelectOption key={name} value={name}>
                        {name} ({count.toLocaleString()})
                      </SelectOption>
                    ))}
                  </SelectList>
                </Select>
              </ToolbarFilter>
            </ToolbarToggleGroup>
            )}
          </ToolbarContent>
        </Toolbar>

        <PackageRowActionsProvider>
        <PackageDetailsDrawer
          activeKey={activeRowKey}
          packageDetails={selectedPackage}
          isLoading={detailsLoading}
          onClose={closeDetails}
          error={detailsError}
          errorCode={detailsErrorCode}
          errorDetails={detailsErrorContext}
          isRemoved={detailsRemoved}
        >
        {!hasSearched ? (
          <EmptyState headingLevel="h3" titleText="Search for packages" icon={SearchIcon}>
            <EmptyStateBody>
              Enter a search term to find packages available in the Arch Linux repositories.
            </EmptyStateBody>
          </EmptyState>
        ) : loading && results.length === 0 ? (
          <EmptyState headingLevel="h2" icon={Spinner} titleText="Searching repositories">
            <EmptyStateBody>Looking for matching packages…</EmptyStateBody>
          </EmptyState>
        ) : results.length === 0 && repoFilter !== "all" && inOtherRepos > 0 ? (
          <EmptyState headingLevel="h3" titleText={`No results in ${repoFilter}`} icon={SearchIcon}>
            <EmptyStateBody>
              {plural(inOtherRepos, "package")} in other repositories match {currentQuery}.
            </EmptyStateBody>
            <EmptyStateFooter>
              <EmptyStateActions>
                <Button variant="primary" onClick={handleClearRepoFilter}>
                  Clear repository filter
                </Button>
              </EmptyStateActions>
            </EmptyStateFooter>
          </EmptyState>
        ) : results.length === 0 && installedFilter !== "all" && totalInstalled + totalNotInstalled > 0 ? (
          <EmptyState headingLevel="h3" titleText="No packages found" icon={SearchIcon}>
            <EmptyStateBody>
              No {installedFilter === "installed" ? "installed" : "uninstalled"} package matches {currentQuery}.
            </EmptyStateBody>
            <EmptyStateFooter>
              <EmptyStateActions>
                <Button variant="primary" onClick={handleShowAllResults}>
                  Show all results
                </Button>
              </EmptyStateActions>
            </EmptyStateFooter>
          </EmptyState>
        ) : results.length === 0 ? (
          <EmptyState headingLevel="h3" titleText="No packages found" icon={SearchIcon}>
            <EmptyStateBody>
              No package in the synced databases matches {currentQuery}.
              {onSearchInstalled && " Packages built locally or from the AUR are listed only under installed packages."}
            </EmptyStateBody>
            {onSearchInstalled && (
              <EmptyStateFooter>
                <EmptyStateActions>
                  <Button variant="primary" onClick={() => onSearchInstalled(currentQuery)}>
                    Search installed packages
                  </Button>
                </EmptyStateActions>
              </EmptyStateFooter>
            )}
          </EmptyState>
        ) : (
          <>
            <Toolbar>
              <ToolbarContent>
                <ToolbarItem>
                  <span style={{ color: "var(--pf-t--global--text--color--subtle)" }}>
                    Found {plural(total, "package")}{inRepo}
                  </span>
                </ToolbarItem>
                <ToolbarItem variant="pagination" align={{ default: "alignEnd" }}>
                  <CompactPagination
                    itemCount={total}
                    perPage={perPage}
                    page={page}
                    onSetPage={handleSetPage}
                    onPerPageSelect={handlePerPageSelect}
                  />
                </ToolbarItem>
              </ToolbarContent>
            </Toolbar>
            <div style={{ position: "relative" }}>
              {loading && (
                <div style={{ position: "absolute", top: 0, right: 0, padding: "0.5rem", zIndex: 1 }}>
                  <Spinner size="md" />
                </div>
              )}
              <div style={{ opacity: loading ? 0.6 : 1, transition: "opacity 0.2s" }}>
              <Table aria-label="Search results" variant="compact">
                <Thead noWrap>
                  <Tr>
                    <Th sort={getSortParams(0)}>Name</Th>
                    <Th>Version</Th>
                    <Th>Description</Th>
                    <Th sort={getSortParams(3)}>Repository</Th>
                    <Th sort={getSortParams(4)}>Status</Th>
                    <Th screenReaderText="Actions" />
                  </Tr>
                </Thead>
                <Tbody>
                  {results.map((pkg: SearchResult) => (
                    <Tr
                      key={rowKey(pkg)}
                      isClickable
                      onRowClick={(event) => !fromRowActions(event) && handleRowClick(pkg)}
                      {...detailsRowProps(activeRowKey === rowKey(pkg))}
                    >
                      <Td dataLabel="Name">
                        <Button variant="link" isInline className="pf-v6-u-p-0" {...{ [DETAILS_TRIGGER_ATTR]: rowKey(pkg) }}>
                          {pkg.name}
                        </Button>
                      </Td>
                      <Td dataLabel="Version"><Label isCompact variant="outline">{pkg.version}</Label></Td>
                      <Td dataLabel="Description">{pkg.description || "-"}</Td>
                      <Td dataLabel="Repository">
                        <Label isCompact color="grey">{pkg.repository}</Label>
                      </Td>
                      <Td dataLabel="Status">
                        {pkg.installed ? (
                          <Label color="green">
                            Installed{pkg.installed_version !== pkg.version ? ` (${pkg.installed_version})` : ""}
                          </Label>
                        ) : (
                          <Label color="grey">Not installed</Label>
                        )}
                      </Td>
                      <Td isActionCell>
                        <PackageRowActions
                          name={pkg.name}
                          installedVersion={pkg.installed ? pkg.installed_version : null}
                          repository={pkg.repository}
                          syncVersion={pkg.version}
                          onViewDetails={() => handleRowClick(pkg)}
                        />
                      </Td>
                    </Tr>
                  ))}
                </Tbody>
              </Table>
              </div>
            </div>
            <Toolbar>
              <ToolbarContent>
                <ToolbarItem variant="pagination" align={{ default: "alignEnd" }}>
                  <CompactPagination
                    itemCount={total}
                    perPage={perPage}
                    page={page}
                    onSetPage={handleSetPage}
                    onPerPageSelect={handlePerPageSelect}
                  />
                </ToolbarItem>
              </ToolbarContent>
            </Toolbar>
          </>
        )}
        </PackageDetailsDrawer>
        </PackageRowActionsProvider>
      </CardBody>
    </Card>
    </>
  );
};
