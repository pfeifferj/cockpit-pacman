import React, { useState, useEffect, useCallback, useMemo } from "react";
import {
  Alert,
  Badge,
  Card,
  CardBody,
  Checkbox,
  Spinner,
  Button,
  Label,
  Pagination,
  Toolbar,
  ToolbarContent,
  ToolbarItem,
  ToggleGroup,
  ToggleGroupItem,
  SearchInput,
  EmptyState,
  EmptyStateBody,
  Flex,
  FlexItem,
  MenuToggle,
  Select,
  SelectOption,
  SelectList,
} from "@patternfly/react-core";
import {
  Table,
  Thead,
  Tbody,
  Tr,
  Th,
  Td,
} from "@patternfly/react-table";
import {
  CheckCircleIcon,
  ExclamationTriangleIcon,
  SyncAltIcon,
} from "@patternfly/react-icons";
import type {
  KeyringCredentials,
  SignoffGroupWithLocal,
  SignoffListResponse,
} from "../api";
import {
  getSignoffList,
  signoffPackage,
  revokeSignoff,
} from "../api";
import { usePackageDetails } from "../hooks/usePackageDetails";
import { usePagination } from "../hooks/usePagination";
import { useSortableTable } from "../hooks/useSortableTable";
import { PackageDetailsModal } from "./PackageDetailsModal";
import { sanitizeErrorMessage } from "../utils";
import { PER_PAGE_OPTIONS } from "../constants";

type SignoffFilter = "installed" | "pending" | "signed" | "bad";

const isInstalled = (g: SignoffGroupWithLocal) => g.version_match !== "not_installed";
const isPending = (g: SignoffGroupWithLocal) =>
  !g.approved && !g.known_bad && g.signoffs.filter((s) => !s.revoked).length < g.required;
const isSignedBy = (g: SignoffGroupWithLocal, user: string) =>
  g.signoffs.some((s) => !s.revoked && s.user === user);
const isKnownBad = (g: SignoffGroupWithLocal) => g.known_bad;
const signoffKey = (g: SignoffGroupWithLocal) => `${g.pkgbase}\0${g.repo}\0${g.arch}`;

interface SignoffsViewProps {
  credentials: KeyringCredentials;
}

export const SignoffsView: React.FC<SignoffsViewProps> = ({ credentials }) => {
  const username = credentials.username;
  const [loading, setLoading] = useState(false);
  const [data, setData] = useState<SignoffListResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [search, setSearch] = useState("");
  const [filters, setFilters] = useState<Set<SignoffFilter>>(new Set(["installed"]));
  const [actionInProgress, setActionInProgress] = useState<string | null>(null);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [bulkInProgress, setBulkInProgress] = useState(false);
  const [repoFilter, setRepoFilter] = useState("all");
  const [repoSelectOpen, setRepoSelectOpen] = useState(false);
  const { selectedPackage, detailsLoading, detailsError, fetchDetails, clearDetails } = usePackageDetails();
  const { page, perPage, onSetPage, onPerPageSelect, resetPage } = usePagination({ defaultPerPage: 20 });

  // Column indices: 0=checkbox, 1=package, 2=version, 3=local, 4=signoffs, 5=status, 6=actions
  const sortColumns = { package: 1, version: 2, signoffs: 4, status: 5 } as const;
  type SortKey = keyof typeof sortColumns;
  const { activeSortKey, activeSortDirection, getSortParams } = useSortableTable<SortKey>({
    columns: sortColumns,
    defaultDirection: "asc",
  });

  const fetchSignoffs = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const result = await getSignoffList(credentials);
      setData(result);
    } catch (err) {
      setError(sanitizeErrorMessage(err instanceof Error ? err.message : null));
    } finally {
      setLoading(false);
    }
  }, [credentials]);

  useEffect(() => {
    fetchSignoffs();
  }, [fetchSignoffs]);

  const handleSignoff = async (group: SignoffGroupWithLocal) => {
    setActionInProgress(signoffKey(group));
    try {
      const result = await signoffPackage(
        group.pkgbase,
        group.repo,
        group.arch,
        credentials,
      );
      if (!result.success) {
        setError(result.error || "Signoff failed");
      }
      await fetchSignoffs();
    } catch (err) {
      setError(sanitizeErrorMessage(err instanceof Error ? err.message : null));
    } finally {
      setActionInProgress(null);
    }
  };

  const handleRevoke = async (group: SignoffGroupWithLocal) => {
    setActionInProgress(signoffKey(group));
    try {
      const result = await revokeSignoff(
        group.pkgbase,
        group.repo,
        group.arch,
        credentials,
      );
      if (!result.success) {
        setError(result.error || "Revoke failed");
      }
      await fetchSignoffs();
    } catch (err) {
      setError(sanitizeErrorMessage(err instanceof Error ? err.message : null));
    } finally {
      setActionInProgress(null);
    }
  };

  const toggleSelection = (key: string) => {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key); else next.add(key);
      return next;
    });
  };

  const toggleFilter = (f: SignoffFilter) => {
    setFilters((prev) => {
      const next = new Set(prev);
      if (next.has(f)) next.delete(f); else next.add(f);
      return next;
    });
    resetPage();
  };

  const filterCounts = useMemo(() => {
    const groups = data?.signoff_groups ?? [];
    return {
      all: groups.length,
      installed: groups.filter(isInstalled).length,
      pending: groups.filter(isPending).length,
      signed: groups.filter((g) => isSignedBy(g, username)).length,
      bad: groups.filter(isKnownBad).length,
    };
  }, [data, username]);

  const repositories = useMemo(() => {
    const groups = data?.signoff_groups ?? [];
    return [...new Set(groups.map((g) => g.repo))].sort();
  }, [data]);

  const filteredGroups = useMemo(() => {
    const groups = data?.signoff_groups ?? [];
    const filtered = groups.filter((g) => {
      if (repoFilter !== "all" && g.repo !== repoFilter) return false;
      if (search) {
        const lower = search.toLowerCase();
        const matchesSearch =
          g.pkgbase.toLowerCase().includes(lower) ||
          g.pkgnames.some((n) => n.toLowerCase().includes(lower)) ||
          g.repo.toLowerCase().includes(lower);
        if (!matchesSearch) return false;
      }
      if (filters.size === 0) return true;
      if (filters.has("installed") && !isInstalled(g)) return false;
      if (filters.has("pending") && !isPending(g)) return false;
      if (filters.has("signed") && !isSignedBy(g, username)) return false;
      if (filters.has("bad") && !isKnownBad(g)) return false;
      return true;
    });
    if (!activeSortKey) return filtered;
    return [...filtered].sort((a, b) => {
      let cmp = 0;
      switch (activeSortKey) {
        case "package":
          cmp = a.pkgbase.localeCompare(b.pkgbase);
          break;
        case "version":
          cmp = a.version.localeCompare(b.version);
          break;
        case "signoffs": {
          const aCount = a.signoffs.filter((s) => !s.revoked).length;
          const bCount = b.signoffs.filter((s) => !s.revoked).length;
          cmp = aCount - bCount;
          break;
        }
        case "status": {
          const rank = (g: SignoffGroupWithLocal) => g.known_bad ? 0 : g.approved ? 2 : 1;
          cmp = rank(a) - rank(b);
          break;
        }
      }
      return activeSortDirection === "asc" ? cmp : -cmp;
    });
  }, [data, search, filters, repoFilter, username, activeSortKey, activeSortDirection]);

  const pagedGroups = useMemo(() => {
    const start = (page - 1) * perPage;
    return filteredGroups.slice(start, start + perPage);
  }, [filteredGroups, page, perPage]);

  const selectableGroups = useMemo(() => {
    return filteredGroups.filter((g) => {
      if (g.known_bad) return false;
      return !g.signoffs.some((s) => !s.revoked && s.user === username);
    });
  }, [filteredGroups, username]);

  const selectAll = () => setSelected(new Set(selectableGroups.map(signoffKey)));
  const deselectAll = () => setSelected(new Set());
  const areAllSelected = selectableGroups.length > 0 && selectableGroups.every((g) => selected.has(signoffKey(g)));
  const areSomeSelected = selectableGroups.some((g) => selected.has(signoffKey(g)));
  const selectedCount = filteredGroups.filter((g) => selected.has(signoffKey(g))).length;

  const handleBulkSignoff = async () => {
    const toSign = filteredGroups.filter((g) => selected.has(signoffKey(g)));
    if (toSign.length === 0) return;
    setBulkInProgress(true);
    const errors: string[] = [];
    for (const group of toSign) {
      try {
        const result = await signoffPackage(group.pkgbase, group.repo, group.arch, credentials);
        if (!result.success) {
          errors.push(`${group.pkgbase}: ${result.error || "failed"}`);
        }
      } catch (err) {
        errors.push(`${group.pkgbase}: ${err instanceof Error ? err.message : "failed"}`);
      }
    }
    if (errors.length > 0) {
      setError(errors.join("; "));
    }
    setSelected(new Set());
    await fetchSignoffs();
    setBulkInProgress(false);
  };

  const renderVersionMatch = (group: SignoffGroupWithLocal) => {
    if (group.version_match === "match") {
      return <Label color="green" icon={<CheckCircleIcon />} isCompact>{group.local_version}</Label>;
    }
    if (group.version_match === "mismatch") {
      return <Label color="orange" icon={<ExclamationTriangleIcon />} isCompact>{group.local_version}</Label>;
    }
    return <Label color="grey" isCompact>not installed</Label>;
  };

  const renderStatus = (group: SignoffGroupWithLocal) => {
    if (group.known_bad) return <Label color="red" isCompact>Known Bad</Label>;
    if (group.approved) return <Label color="green" isCompact>Approved</Label>;
    return <Label color="blue" isCompact>Pending</Label>;
  };

  const hasFilters = filters.size > 0 || !!search || repoFilter !== "all";

  return (
    <Card>
      <CardBody>
      {error && (
        <Alert
          variant="danger"
          isInline
          title="Error"
          actionClose={<Button variant="plain" onClick={() => setError(null)}>Dismiss</Button>}
          className="pf-v6-u-mb-md"
        >
          {error}
        </Alert>
      )}

      <Toolbar>
        <ToolbarContent>
          <ToolbarItem>
            <SearchInput
              placeholder="Filter packages..."
              value={search}
              onChange={(_event, value) => { setSearch(value); resetPage(); }}
              onClear={() => { setSearch(""); resetPage(); }}
            />
          </ToolbarItem>
          <ToolbarItem>
            <ToggleGroup aria-label="Signoff filter">
              <ToggleGroupItem
                text={<>Installed <Badge isRead>{filterCounts.installed}</Badge></>}
                isSelected={filters.has("installed")}
                onChange={() => toggleFilter("installed")}
              />
              <ToggleGroupItem
                text={<>Pending <Badge isRead>{filterCounts.pending}</Badge></>}
                isSelected={filters.has("pending")}
                onChange={() => toggleFilter("pending")}
              />
              <ToggleGroupItem
                text={<>Signed by me <Badge isRead>{filterCounts.signed}</Badge></>}
                isSelected={filters.has("signed")}
                onChange={() => toggleFilter("signed")}
              />
              {filterCounts.bad > 0 && (
                <ToggleGroupItem
                  text={<>Known bad <Badge isRead>{filterCounts.bad}</Badge></>}
                  isSelected={filters.has("bad")}
                  onChange={() => toggleFilter("bad")}
                />
              )}
            </ToggleGroup>
          </ToolbarItem>
          <ToolbarItem>
            <Select
              aria-label="Filter by repository"
              isOpen={repoSelectOpen}
              selected={repoFilter}
              onSelect={(_event, value) => {
                setRepoFilter(value as string);
                setRepoSelectOpen(false);
                resetPage();
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
                {repositories.map((repo) => (
                  <SelectOption key={repo} value={repo}>{repo}</SelectOption>
                ))}
              </SelectList>
            </Select>
          </ToolbarItem>
          <ToolbarItem>
            <Button
              variant="plain"
              onClick={fetchSignoffs}
              isDisabled={loading || bulkInProgress}
              icon={<SyncAltIcon />}
            >
              Refresh
            </Button>
          </ToolbarItem>
          {selectedCount > 0 && (
            <ToolbarItem>
              <Button
                variant="primary"
                onClick={handleBulkSignoff}
                isLoading={bulkInProgress}
                isDisabled={bulkInProgress || !!actionInProgress}
              >
                Sign off {selectedCount} package{selectedCount !== 1 ? "s" : ""}
              </Button>
            </ToolbarItem>
          )}
          <ToolbarItem variant="pagination" align={{ default: "alignEnd" }}>
            <Pagination
              itemCount={filteredGroups.length}
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

      {loading && !data ? (
        <Flex justifyContent={{ default: "justifyContentCenter" }} className="pf-v6-u-mt-xl">
          <Spinner size="lg" />
        </Flex>
      ) : filteredGroups.length === 0 ? (
        <EmptyState headingLevel="h3" titleText={hasFilters ? "No matching packages" : "No packages awaiting signoff"}>
          <EmptyStateBody>
            {hasFilters ? "Try a different search term or filter." : "All packages have been signed off or none require signoff."}
          </EmptyStateBody>
        </EmptyState>
      ) : (
        <Table aria-label="Signoff packages" variant="compact">
          <Thead>
            <Tr>
              <Th screenReaderText="Select">
                <Checkbox
                  id="select-all-signoffs"
                  isChecked={areAllSelected ? true : areSomeSelected ? null : false}
                  onChange={(_event, checked) => checked ? selectAll() : deselectAll()}
                  isDisabled={bulkInProgress || !!actionInProgress}
                  aria-label="Select all packages"
                />
              </Th>
              <Th sort={getSortParams("package")}>Package</Th>
              <Th sort={getSortParams("version")}>Version</Th>
              <Th>Local</Th>
              <Th sort={getSortParams("signoffs")}>Signoffs</Th>
              <Th sort={getSortParams("status")}>Status</Th>
              <Th>Actions</Th>
            </Tr>
          </Thead>
          <Tbody>
            {pagedGroups.map((group, rowIndex) => {
              const key = signoffKey(group);
              const isActing = actionInProgress === key;
              const userHasSignoff = group.signoffs.some((s) => !s.revoked && s.user === username);
              const signoffCount = group.signoffs.filter((s) => !s.revoked).length;
              const canSelect = !group.known_bad && !userHasSignoff;

              return (
                <Tr key={key} isRowSelected={selected.has(key)}>
                  <Td
                    select={{
                      rowIndex,
                      onSelect: () => toggleSelection(key),
                      isSelected: selected.has(key),
                      isDisabled: !canSelect || bulkInProgress || !!actionInProgress,
                    }}
                    onClick={(e) => e.stopPropagation()}
                  />
                  <Td dataLabel="Package">
                    <Button variant="link" isInline onClick={() => fetchDetails(group.pkgbase)}>
                      <strong>{group.pkgbase}</strong>
                    </Button>
                    {group.pkgnames.length > 1 && (
                      <div style={{ fontSize: "0.85em", color: "var(--pf-t--global--color--200)" }}>
                        {group.pkgnames.join(", ")}
                      </div>
                    )}
                    <div>
                      <Label isCompact color="grey">{group.repo}</Label>{" "}
                      <Label isCompact color="grey">{group.arch}</Label>
                    </div>
                  </Td>
                  <Td dataLabel="Version">
                    <Label isCompact variant="outline">{group.version}</Label>
                  </Td>
                  <Td dataLabel="Local">{renderVersionMatch(group)}</Td>
                  <Td dataLabel="Signoffs">
                    {signoffCount} / {group.required}
                  </Td>
                  <Td dataLabel="Status">{renderStatus(group)}</Td>
                  <Td dataLabel="Actions">
                    {isActing ? (
                      <Spinner size="md" />
                    ) : (
                      <Flex spaceItems={{ default: "spaceItemsSm" }}>
                        <FlexItem>
                          <Button
                            variant="primary"
                            size="sm"
                            onClick={() => handleSignoff(group)}
                            isDisabled={group.known_bad || userHasSignoff || !!actionInProgress}
                          >
                            Sign off
                          </Button>
                        </FlexItem>
                        <FlexItem>
                          <Button
                            variant="secondary"
                            size="sm"
                            onClick={() => handleRevoke(group)}
                            isDisabled={!userHasSignoff || !!actionInProgress}
                          >
                            Revoke
                          </Button>
                        </FlexItem>
                      </Flex>
                    )}
                  </Td>
                </Tr>
              );
            })}
          </Tbody>
        </Table>
      )}

      {filteredGroups.length > 0 && (
        <Pagination
          itemCount={filteredGroups.length}
          perPage={perPage}
          page={page}
          onSetPage={onSetPage}
          onPerPageSelect={onPerPageSelect}
          perPageOptions={PER_PAGE_OPTIONS}
          variant="bottom"
        />
      )}

      <PackageDetailsModal
        packageDetails={selectedPackage}
        isLoading={detailsLoading}
        onClose={clearDetails}
        error={detailsError}
      />
      </CardBody>
    </Card>
  );
};
