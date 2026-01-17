import React, { useState, useMemo, useEffect, useRef } from "react";
import {
  Card,
  CardBody,
  Spinner,
  Alert,
  SearchInput,
  Toolbar,
  ToolbarContent,
  ToolbarItem,
  Label,
  EmptyState,
  EmptyStateBody,
  Title,
  MenuToggle,
  MenuToggleElement,
  Select,
  SelectOption,
  SelectList,
  Pagination,
  ToggleGroup,
  ToggleGroupItem,
  Badge,
  Button,
} from "@patternfly/react-core";
import { SearchIcon } from "@patternfly/react-icons";
import { Table, Thead, Tr, Th, Tbody, Td, ThProps } from "@patternfly/react-table";
import { SearchResult, SyncPackageDetails, searchPackages, getSyncPackageInfo, InstalledFilterType } from "../api";
import { sanitizeSearchInput } from "../utils";
import { PackageDetailsModal } from "./PackageDetailsModal";
import { PER_PAGE_OPTIONS, SEARCH_DEBOUNCE_MS } from "../constants";

const MIN_SEARCH_LENGTH = 1;

export const SearchView: React.FC = () => {
  const [results, setResults] = useState<SearchResult[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [searchInput, setSearchInput] = useState("");
  const [currentQuery, setCurrentQuery] = useState("");
  const [hasSearched, setHasSearched] = useState(false);
  const [repoFilter, setRepoFilter] = useState("all");
  const [repoSelectOpen, setRepoSelectOpen] = useState(false);
  const [installedFilter, setInstalledFilter] = useState<InstalledFilterType>("all");
  const [selectedPackage, setSelectedPackage] = useState<SyncPackageDetails | null>(null);
  const [detailsLoading, setDetailsLoading] = useState(false);
  const [page, setPage] = useState(1);
  const [perPage, setPerPage] = useState(50);
  const [total, setTotal] = useState(0);
  const [totalInstalled, setTotalInstalled] = useState(0);
  const [totalNotInstalled, setTotalNotInstalled] = useState(0);
  const [repositories, setRepositories] = useState<string[]>([]);
  const [activeSortIndex, setActiveSortIndex] = useState<number | null>(null);
  const [activeSortDirection, setActiveSortDirection] = useState<"asc" | "desc">("asc");
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Refs to avoid stale closures in debounced callback
  const currentQueryRef = useRef(currentQuery);
  const perPageRef = useRef(perPage);
  currentQueryRef.current = currentQuery;
  perPageRef.current = perPage;

  // Debounced auto-search when input changes
  useEffect(() => {
    if (debounceRef.current) {
      clearTimeout(debounceRef.current);
    }

    const query = sanitizeSearchInput(searchInput);
    if (query.length < MIN_SEARCH_LENGTH) {
      return;
    }

    debounceRef.current = setTimeout(async () => {
      // Use refs to get current values, avoiding stale closure
      if (query !== currentQueryRef.current) {
        setCurrentQuery(query);
        setHasSearched(true);
        setRepoFilter("all");
        setInstalledFilter("all");
        setPage(1);
        setActiveSortIndex(null);
        setLoading(true);
        setError(null);
        try {
          const response = await searchPackages({
            query,
            offset: 0,
            limit: perPageRef.current,
            installed: "all",
          });
          setResults(response.results);
          setTotal(response.total);
          setTotalInstalled(response.total_installed);
          setTotalNotInstalled(response.total_not_installed);
          setRepositories(response.repositories);
        } catch (ex) {
          setError(ex instanceof Error ? ex.message : String(ex));
          setResults([]);
          setTotal(0);
          setTotalInstalled(0);
          setTotalNotInstalled(0);
          setRepositories([]);
        } finally {
          setLoading(false);
        }
      }
    }, SEARCH_DEBOUNCE_MS);

    return () => {
      if (debounceRef.current) {
        clearTimeout(debounceRef.current);
      }
    };
  }, [searchInput]);

  const filteredResults = useMemo(() => {
    if (repoFilter === "all") return results;
    return results.filter((r: SearchResult) => r.repository === repoFilter);
  }, [results, repoFilter]);

  // Map column index to backend sort field
  const getSortField = (index: number | null): string => {
    if (index === null) return "";
    switch (index) {
      case 0: return "name";
      case 3: return "repository";
      case 4: return "status";
      default: return "";
    }
  };

  const fetchResults = async (query: string, pageNum: number, pageSize: number, installed: InstalledFilterType, updateRepos = false, sortIdx: number | null = null, sortDirection: "asc" | "desc" = "asc") => {
    setLoading(true);
    setError(null);
    try {
      const offset = (pageNum - 1) * pageSize;
      const response = await searchPackages({
        query,
        offset,
        limit: pageSize,
        installed,
        sortBy: getSortField(sortIdx),
        sortDir: sortDirection,
      });
      setResults(response.results);
      setTotal(response.total);
      setTotalInstalled(response.total_installed);
      setTotalNotInstalled(response.total_not_installed);
      if (updateRepos) {
        setRepositories(response.repositories);
      }
    } catch (ex) {
      setError(ex instanceof Error ? ex.message : String(ex));
      setResults([]);
      setTotal(0);
      setTotalInstalled(0);
      setTotalNotInstalled(0);
      if (updateRepos) {
        setRepositories([]);
      }
    } finally {
      setLoading(false);
    }
  };

  const handleSearch = async () => {
    // Cancel any pending debounce when manually searching
    if (debounceRef.current) {
      clearTimeout(debounceRef.current);
    }

    const query = sanitizeSearchInput(searchInput);
    if (query.length < MIN_SEARCH_LENGTH) {
      setError(`Search query must be at least ${MIN_SEARCH_LENGTH} characters`);
      return;
    }

    setCurrentQuery(query);
    setHasSearched(true);
    setRepoFilter("all");
    setInstalledFilter("all");
    setPage(1);
    setActiveSortIndex(null);
    await fetchResults(query, 1, perPage, "all", true);
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
    setHasSearched(false);
    setRepoFilter("all");
    setInstalledFilter("all");
    setPage(1);
    setTotal(0);
    setRepositories([]);
    setActiveSortIndex(null);
  };

  const handleSetPage = (_event: React.MouseEvent | React.KeyboardEvent | MouseEvent, newPage: number) => {
    setPage(newPage);
    if (currentQuery) {
      fetchResults(currentQuery, newPage, perPage, installedFilter, false, activeSortIndex, activeSortDirection);
    }
  };

  const handlePerPageSelect = (_event: React.MouseEvent | React.KeyboardEvent | MouseEvent, newPerPage: number) => {
    setPerPage(newPerPage);
    setPage(1);
    if (currentQuery) {
      fetchResults(currentQuery, 1, newPerPage, installedFilter, false, activeSortIndex, activeSortDirection);
    }
  };

  const handleInstalledFilterChange = (value: InstalledFilterType) => {
    setInstalledFilter(value);
    setPage(1);
    if (currentQuery) {
      fetchResults(currentQuery, 1, perPage, value, false, activeSortIndex, activeSortDirection);
    }
  };

  const handleRowClick = async (pkgName: string, repo: string) => {
    setDetailsLoading(true);
    try {
      const details = await getSyncPackageInfo(pkgName, repo);
      setSelectedPackage(details);
    } catch (ex) {
      setError(ex instanceof Error ? ex.message : String(ex));
    } finally {
      setDetailsLoading(false);
    }
  };

  // Column indices: 0=name, 1=version, 2=description, 3=repository, 4=status
  const sortableColumns = [0, 3, 4]; // name, repository, status

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
        setPage(1);
        if (currentQuery) {
          fetchResults(currentQuery, 1, perPage, installedFilter, false, index, direction);
        }
      },
      columnIndex,
    };
  };

  return (
    <Card>
      <CardBody>
        <Toolbar>
          <ToolbarContent>
            <ToolbarItem >
              <SearchInput
                placeholder="Search Arch repositories..."
                value={searchInput}
                onChange={(_event: React.SyntheticEvent, value: string) => setSearchInput(value)}
                onClear={handleSearchClear}
                onSearch={handleSearch}
              />
            </ToolbarItem>
            {hasSearched && (
              <ToolbarItem>
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
              </ToolbarItem>
            )}
            {repositories.length > 0 && (
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
                    {repositories.map((repo: string) => (
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

        {error && (() => {
          const isLockError = error.toLowerCase().includes("unable to lock database");
          return (
            <Alert
              variant={isLockError ? "warning" : "danger"}
              title={isLockError ? "Database is locked" : "Search failed"}
              isInline
              style={{ marginBottom: "1rem" }}
            >
              {isLockError
                ? "Another package manager operation is in progress. Please wait for it to complete before searching."
                : error}
            </Alert>
          );
        })()}

        {loading ? (
          <div style={{ padding: "2rem", textAlign: "center" }}>
            <Spinner /> Searching repositories...
          </div>
        ) : !hasSearched ? (
          <EmptyState titleText={<Title headingLevel="h4" size="lg">
              Search for packages
            </Title>} icon={SearchIcon}>
            <EmptyStateBody>
              Enter a search term to find packages available in the Arch Linux repositories.
            </EmptyStateBody>
          </EmptyState>
        ) : filteredResults.length === 0 ? (
          <EmptyState titleText={<Title headingLevel="h4" size="lg">
              No packages found
            </Title>} icon={SearchIcon}>
            <EmptyStateBody>
              No packages matched your search. Try a different search term.
            </EmptyStateBody>
          </EmptyState>
        ) : (
          <>
            <Toolbar>
              <ToolbarContent>
                <ToolbarItem>
                  <span style={{ color: "var(--pf-t--global--text--color--subtle)" }}>
                    Found {total} package{total !== 1 ? "s" : ""}
                    {repoFilter !== "all" && ` (${filteredResults.length} in ${repoFilter})`}
                  </span>
                </ToolbarItem>
                <ToolbarItem variant="pagination" align={{ default: "alignEnd" }}>
                  <Pagination
                    itemCount={total}
                    perPage={perPage}
                    page={page}
                    onSetPage={handleSetPage}
                    onPerPageSelect={handlePerPageSelect}
                    perPageOptions={PER_PAGE_OPTIONS}
                    isCompact
                  />
                </ToolbarItem>
              </ToolbarContent>
            </Toolbar>
            <Table aria-label="Search results" variant="compact">
              <Thead>
                <Tr>
                  <Th sort={getSortParams(0)}>Name</Th>
                  <Th>Version</Th>
                  <Th>Description</Th>
                  <Th sort={getSortParams(3)}>Repository</Th>
                  <Th sort={getSortParams(4)}>Status</Th>
                </Tr>
              </Thead>
              <Tbody>
                {filteredResults.map((pkg: SearchResult) => (
                  <Tr
                    key={`${pkg.repository}/${pkg.name}`}
                    isClickable
                    onRowClick={() => handleRowClick(pkg.name, pkg.repository)}
                  >
                    <Td dataLabel="Name">
                      <Button variant="link" isInline style={{ padding: 0 }}>
                        {pkg.name}
                      </Button>
                    </Td>
                    <Td dataLabel="Version">{pkg.version}</Td>
                    <Td dataLabel="Description">{pkg.description || "-"}</Td>
                    <Td dataLabel="Repository">
                      <Label color="blue">{pkg.repository}</Label>
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
                  </Tr>
                ))}
              </Tbody>
            </Table>
            <Toolbar>
              <ToolbarContent>
                <ToolbarItem variant="pagination" align={{ default: "alignEnd" }}>
                  <Pagination
                    itemCount={total}
                    perPage={perPage}
                    page={page}
                    onSetPage={handleSetPage}
                    onPerPageSelect={handlePerPageSelect}
                    perPageOptions={PER_PAGE_OPTIONS}
                    isCompact
                  />
                </ToolbarItem>
              </ToolbarContent>
            </Toolbar>
          </>
        )}

        <PackageDetailsModal
          packageDetails={selectedPackage}
          isLoading={detailsLoading}
          onClose={() => setSelectedPackage(null)}
        />
      </CardBody>
    </Card>
  );
};
