import React, { useState, useMemo } from "react";
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
  EmptyStateIcon,
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

const MIN_SEARCH_LENGTH = 2;
const PER_PAGE_OPTIONS = [
  { title: "20", value: 20 },
  { title: "50", value: 50 },
  { title: "100", value: 100 },
];

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
    setActiveSortIndex(null); // Reset sort on new search
    await fetchResults(query, 1, perPage, "all", true);
  };

  const handleSearchClear = () => {
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
            <ToolbarItem variant="search-filter">
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

        {error && (
          <Alert variant="danger" title="Search failed" isInline style={{ marginBottom: "1rem" }}>
            {error}
          </Alert>
        )}

        {loading ? (
          <div style={{ padding: "2rem", textAlign: "center" }}>
            <Spinner /> Searching repositories...
          </div>
        ) : !hasSearched ? (
          <EmptyState>
            <EmptyStateIcon icon={SearchIcon} />
            <Title headingLevel="h4" size="lg">
              Search for packages
            </Title>
            <EmptyStateBody>
              Enter a search term to find packages available in the Arch Linux repositories.
            </EmptyStateBody>
          </EmptyState>
        ) : filteredResults.length === 0 ? (
          <EmptyState>
            <EmptyStateIcon icon={SearchIcon} />
            <Title headingLevel="h4" size="lg">
              No packages found
            </Title>
            <EmptyStateBody>
              No packages matched your search. Try a different search term.
            </EmptyStateBody>
          </EmptyState>
        ) : (
          <>
            <Toolbar>
              <ToolbarContent>
                <ToolbarItem>
                  <span style={{ color: "var(--pf-v5-global--Color--200)" }}>
                    Found {total} package{total !== 1 ? "s" : ""}
                    {repoFilter !== "all" && ` (${filteredResults.length} in ${repoFilter})`}
                  </span>
                </ToolbarItem>
                <ToolbarItem variant="pagination" align={{ default: "alignRight" }}>
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
                <ToolbarItem variant="pagination" align={{ default: "alignRight" }}>
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
