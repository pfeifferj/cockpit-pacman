import React, { useState, useEffect, useCallback, useRef } from "react";
import { useDebouncedValue } from "../hooks/useDebounce";
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
} from "@patternfly/react-core";
import { Table, Thead, Tr, Th, Tbody, Td, ThProps } from "@patternfly/react-table";
import {
  Package,
  PackageDetails,
  PackageListResponse,
  FilterType,
  listInstalled,
  getPackageInfo,
  formatSize,
} from "../api";
import { sanitizeSearchInput } from "../utils";
import { PackageDetailsModal } from "./PackageDetailsModal";
import { PER_PAGE_OPTIONS, SEARCH_DEBOUNCE_MS } from "../constants";

export const PackageList: React.FC = () => {
  const [packages, setPackages] = useState<Package[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [searchValue, setSearchValue] = useState("");
  const [searchInput, setSearchInput] = useState("");
  const [filter, setFilter] = useState<FilterType>("all");
  const [selectedPackage, setSelectedPackage] = useState<PackageDetails | null>(null);
  const [detailsLoading, setDetailsLoading] = useState(false);

  const [page, setPage] = useState(1);
  const [perPage, setPerPage] = useState(50);
  const [total, setTotal] = useState(0);
  const [totalExplicit, setTotalExplicit] = useState(0);
  const [totalDependency, setTotalDependency] = useState(0);
  const [repositories, setRepositories] = useState<string[]>([]);
  const [repoFilter, setRepoFilter] = useState("all");
  const [repoSelectOpen, setRepoSelectOpen] = useState(false);
  const [activeSortIndex, setActiveSortIndex] = useState<number | null>(null);
  const [activeSortDirection, setActiveSortDirection] = useState<"asc" | "desc">("asc");
  const manualSearchRef = useRef(false);

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
  }, [debouncedSearchInput, searchValue]);

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

  const loadPackages = useCallback(async () => {
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
      setPackages(response.packages);
      setTotal(response.total);
      setTotalExplicit(response.total_explicit);
      setTotalDependency(response.total_dependency);
      setRepositories(response.repositories || []);
    } catch (ex) {
      setError(ex instanceof Error ? ex.message : String(ex));
    } finally {
      setLoading(false);
    }
  }, [page, perPage, searchValue, filter, repoFilter, activeSortIndex, activeSortDirection]);

  useEffect(() => {
    loadPackages();
  }, [loadPackages]);

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
      setSelectedPackage(details);
    } catch (ex) {
      setError(ex instanceof Error ? ex.message : String(ex));
    } finally {
      setDetailsLoading(false);
    }
  };

  const handleSetPage = (_event: React.MouseEvent | React.KeyboardEvent | MouseEvent, newPage: number) => {
    setPage(newPage);
  };

  const handlePerPageSelect = (_event: React.MouseEvent | React.KeyboardEvent | MouseEvent, newPerPage: number) => {
    setPerPage(newPerPage);
    setPage(1);
  };

  // Column indices: 0=name, 1=version, 2=description, 3=size, 4=reason
  const sortableColumns = [0, 3, 4]; // name, size, reason

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
        setPage(1); // Reset to first page when sorting changes
      },
      columnIndex,
    };
  };

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

  return (
    <Card>
      <CardBody>
        <Toolbar>
          <ToolbarContent>
            <ToolbarItem >
              <SearchInput
                placeholder="Search packages..."
                value={searchInput}
                onChange={(_event, value) => setSearchInput(value)}
                onClear={handleSearchClear}
                onSearch={handleSearch}
              />
            </ToolbarItem>
            <ToolbarItem>
              <ToggleGroup aria-label="Package filter">
                <ToggleGroupItem
                  text={<>All <Badge isRead>{totalExplicit + totalDependency}</Badge></>}
                  isSelected={filter === "all"}
                  onChange={() => handleFilterChange("all")}
                />
                <ToggleGroupItem
                  text={<>Explicit <Badge isRead>{totalExplicit}</Badge></>}
                  isSelected={filter === "explicit"}
                  onChange={() => handleFilterChange("explicit")}
                />
                <ToggleGroupItem
                  text={<>Dependencies <Badge isRead>{totalDependency}</Badge></>}
                  isSelected={filter === "dependency"}
                  onChange={() => handleFilterChange("dependency")}
                />
              </ToggleGroup>
            </ToolbarItem>
            <ToolbarItem>
              <Select
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
                onSetPage={handleSetPage}
                onPerPageSelect={handlePerPageSelect}
                perPageOptions={PER_PAGE_OPTIONS}
                isCompact
              />
            </ToolbarItem>
          </ToolbarContent>
        </Toolbar>

        {loading && packages.length === 0 ? (
          <div className="pf-v6-u-p-xl pf-v6-u-text-align-center">
            <Spinner /> Loading packages...
          </div>
        ) : (
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
        )}

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

        <PackageDetailsModal
          packageDetails={selectedPackage}
          isLoading={detailsLoading}
          onClose={() => setSelectedPackage(null)}
        />
      </CardBody>
    </Card>
  );
};
