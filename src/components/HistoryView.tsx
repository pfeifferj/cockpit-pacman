import React, { useState, useEffect, useCallback, useRef } from "react";
import { usePackageDetails } from "../hooks/usePackageDetails";
import { usePagination } from "../hooks/usePagination";
import {
  Accordion,
  AccordionContent,
  AccordionItem,
  AccordionToggle,
  Card,
  CardBody,
  CardTitle,
  Button,
  EmptyState,
  EmptyStateBody,
  EmptyStateActions,
  EmptyStateFooter,
  Spinner,
  Flex,
  FlexItem,
  Label,
  MenuToggle,
  Pagination,
  SearchInput,
  Select,
  SelectOption,
  ToggleGroup,
  ToggleGroupItem,
  Toolbar,
  ToolbarContent,
  ToolbarItem,
} from "@patternfly/react-core";
import { CompactPagination } from "./CompactPagination";
import { PackageDetailsModal } from "./PackageDetailsModal";
import { StatBox } from "./StatBox";
import { HistoryIcon, ArrowUpIcon, ArrowDownIcon, PlusIcon, MinusIcon, ExclamationCircleIcon } from "@patternfly/react-icons";
import { Table, Thead, Tr, Th, Tbody, Td } from "@patternfly/react-table";
import {
  LogEntry,
  LogGroup,
  LogResponse,
  GroupedLogResponse,
  HistoryFilterType,
  HistoryParams,
  getGroupedHistory,
  getHistory,
} from "../api";
import { TimeAgo } from "./TimeAgo";
import { sanitizeErrorMessage, sanitizeSearchInput } from "../utils";
import { SEARCH_DEBOUNCE_MS } from "../constants";

type ViewState = "loading" | "ready" | "error";
type ViewMode = "grouped" | "flat";

const ACTION_COLORS: Record<string, "blue" | "green" | "red" | "orange" | "grey"> = {
  upgraded: "blue",
  downgraded: "orange",
  installed: "green",
  removed: "red",
  reinstalled: "grey",
};

const ACTION_ICONS: Record<string, React.ReactNode> = {
  upgraded: <ArrowUpIcon />,
  downgraded: <ArrowDownIcon />,
  installed: <PlusIcon />,
  removed: <MinusIcon />,
  reinstalled: <HistoryIcon />,
};

const PER_PAGE_OPTIONS = [
  { title: "10", value: 10 },
  { title: "20", value: 20 },
  { title: "50", value: 50 },
];

interface HistoryViewProps {
  initialSearch?: { query: string; key: number };
}

export const HistoryView: React.FC<HistoryViewProps> = ({ initialSearch }) => {
  const [state, setState] = useState<ViewState>("loading");
  const [viewMode, setViewMode] = useState<ViewMode>("grouped");
  const [groupedData, setGroupedData] = useState<GroupedLogResponse | null>(null);
  const [flatData, setFlatData] = useState<LogResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const { page, perPage, offset, setPage, onSetPage, onPerPageSelect } = usePagination({ defaultPerPage: 20 });
  const [filter, setFilter] = useState<HistoryFilterType>("all");
  const [filterOpen, setFilterOpen] = useState(false);
  const [searchInput, setSearchInput] = useState("");
  const [searchQuery, setSearchQuery] = useState("");
  const [expandedGroups, setExpandedGroups] = useState<Set<string>>(new Set());
  const expandAllRef = useRef(false);
  const { selectedPackage, detailsLoading, detailsError, fetchDetails, clearDetails } = usePackageDetails();

  useEffect(() => {
    if (!initialSearch) return;
    Promise.resolve().then(() => {
      setSearchInput(initialSearch.query);
      setSearchQuery(initialSearch.query);
      setPage(1);
      expandAllRef.current = true;
    });
  }, [initialSearch, setPage]);

  const fetchHistory = useCallback(
    (params: HistoryParams) => (viewMode === "grouped" ? getGroupedHistory(params) : getHistory(params)),
    [viewMode]
  );

  const applyResponse = useCallback(
    (response: GroupedLogResponse | LogResponse) => {
      if (viewMode === "grouped") {
        const g = response as GroupedLogResponse;
        setGroupedData(g);
        const shouldExpandAll = expandAllRef.current;
        expandAllRef.current = false;
        setExpandedGroups(shouldExpandAll ? new Set(g.groups.map((x) => x.id)) : new Set());
      } else {
        setFlatData(response as LogResponse);
      }
    },
    [viewMode]
  );

  const loadHistory = useCallback(async () => {
    setState("loading");
    setError(null);
    try {
      const response = await fetchHistory({ offset, limit: perPage, filter, search: searchQuery });
      applyResponse(response);
      setState("ready");
    } catch (ex) {
      setState("error");
      setError(ex instanceof Error ? ex.message : String(ex));
    }
  }, [offset, perPage, filter, searchQuery, fetchHistory, applyResponse]);

  useEffect(() => {
    let cancelled = false;
    fetchHistory({ offset, limit: perPage, filter, search: searchQuery })
      .then((response) => {
        if (cancelled) return;
        applyResponse(response);
        setState("ready");
      })
      .catch((ex) => {
        if (cancelled) return;
        setState("error");
        setError(ex instanceof Error ? ex.message : String(ex));
      });
    return () => { cancelled = true; };
  }, [offset, perPage, filter, searchQuery, fetchHistory, applyResponse]);

  useEffect(() => {
    const sanitized = sanitizeSearchInput(searchInput);
    if (sanitized === searchQuery) return;
    const timer = setTimeout(() => {
      setSearchQuery(sanitized);
      setPage(1);
    }, SEARCH_DEBOUNCE_MS);
    return () => clearTimeout(timer);
  }, [searchInput, searchQuery, setPage]);

  const handleRowClick = (pkgName: string) => {
    fetchDetails(pkgName, { strategy: "local-then-sync" });
  };

  const handleFilterChange = (value: HistoryFilterType) => {
    setFilter(value);
    setPage(1);
    setFilterOpen(false);
  };

  const handleViewModeChange = (mode: ViewMode) => {
    if (mode === viewMode) return;
    setState("loading");
    setViewMode(mode);
    setPage(1);
  };

  const allExpanded = groupedData?.groups.length
    ? groupedData.groups.every((g) => expandedGroups.has(g.id))
    : false;

  const toggleAllGroups = () => {
    if (allExpanded) {
      expandAllRef.current = false;
      setExpandedGroups(new Set());
    } else {
      expandAllRef.current = true;
      setExpandedGroups(new Set(groupedData?.groups.map((g) => g.id) || []));
    }
  };

  const toggleGroup = (groupId: string) => {
    expandAllRef.current = false;
    setExpandedGroups((prev) => {
      const next = new Set(prev);
      if (next.has(groupId)) {
        next.delete(groupId);
      } else {
        next.add(groupId);
      }
      return next;
    });
  };

  const formatVersion = (entry: LogEntry): string => {
    if (entry.old_version && entry.new_version) {
      return `${entry.old_version} -> ${entry.new_version}`;
    }
    return entry.old_version || entry.new_version || "";
  };

  const renderEntryRow = (entry: LogEntry, index: number): React.ReactNode => (
    <Tr key={`${entry.timestamp}-${entry.package}-${index}`} isClickable onRowClick={() => handleRowClick(entry.package)}>
      <Td dataLabel="Package">
        <Button variant="link" isInline className="pf-v6-u-p-0">
          {entry.package}
        </Button>
      </Td>
      <Td dataLabel="Version">
        <code>{formatVersion(entry)}</code>
      </Td>
      <Td dataLabel="Action">
        <Label color={ACTION_COLORS[entry.action] || "grey"} icon={ACTION_ICONS[entry.action]}>
          {entry.action}
        </Label>
      </Td>
      <Td dataLabel="Time"><TimeAgo timestamp={entry.timestamp} /></Td>
    </Tr>
  );

  const renderGroupSummary = (group: LogGroup): React.ReactNode => {
    const labels: React.ReactNode[] = [];
    if (group.upgraded_count > 0) {
      labels.push(
        <Label key="upgraded" color="blue" isCompact>
          {group.upgraded_count} upgraded
        </Label>
      );
    }
    if (group.installed_count > 0) {
      labels.push(
        <Label key="installed" color="green" isCompact>
          {group.installed_count} installed
        </Label>
      );
    }
    if (group.removed_count > 0) {
      labels.push(
        <Label key="removed" color="red" isCompact>
          {group.removed_count} removed
        </Label>
      );
    }
    if (group.downgraded_count > 0) {
      labels.push(
        <Label key="downgraded" color="orange" isCompact>
          {group.downgraded_count} downgraded
        </Label>
      );
    }
    if (group.reinstalled_count > 0) {
      labels.push(
        <Label key="reinstalled" color="grey" isCompact>
          {group.reinstalled_count} reinstalled
        </Label>
      );
    }
    return labels;
  };

  // Active dataset for the current view mode drives stats, empty-states, paging.
  const totals = viewMode === "grouped" ? groupedData : flatData;
  const hasData = viewMode === "grouped" ? !!groupedData : !!flatData;
  const itemCount = viewMode === "grouped" ? (groupedData?.total_groups || 0) : (flatData?.total || 0);
  const resultCount = viewMode === "grouped" ? (groupedData?.groups.length || 0) : (flatData?.entries.length || 0);

  if (state === "loading" && !hasData) {
    return (
      <Card>
        <CardBody>
          <EmptyState headingLevel="h2" icon={Spinner} titleText="Loading history">
            <EmptyStateBody>Reading pacman.log...</EmptyStateBody>
          </EmptyState>
        </CardBody>
      </Card>
    );
  }

  if (state === "error" && !hasData) {
    return (
      <Card>
        <CardBody>
          <EmptyState headingLevel="h2" icon={ExclamationCircleIcon} titleText="Error loading history" status="danger">
            <EmptyStateBody>{sanitizeErrorMessage(error)}</EmptyStateBody>
            <EmptyStateFooter>
              <EmptyStateActions>
                <Button variant="primary" onClick={loadHistory}>Retry</Button>
              </EmptyStateActions>
            </EmptyStateFooter>
          </EmptyState>
        </CardBody>
      </Card>
    );
  }

  if (!resultCount && filter === "all" && !searchQuery && state !== "loading") {
    return (
      <Card>
        <CardBody>
          <EmptyState headingLevel="h2" icon={HistoryIcon} titleText="No history found">
            <EmptyStateBody>
              No package history was found in /var/log/pacman.log.
            </EmptyStateBody>
            <EmptyStateFooter>
              <EmptyStateActions>
                <Button variant="secondary" onClick={loadHistory}>
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
            <CardTitle className="pf-v6-u-m-0">Package History</CardTitle>
            <Flex spaceItems={{ default: "spaceItemsLg" }} className="pf-v6-u-mb-md">
              <FlexItem>
                <StatBox
                  label="Upgraded"
                  value={(totals?.total_upgraded || 0).toLocaleString()}
                  color="info"
                />
              </FlexItem>
              <FlexItem>
                <StatBox
                  label="Installed"
                  value={(totals?.total_installed || 0).toLocaleString()}
                  color="success"
                />
              </FlexItem>
              <FlexItem>
                <StatBox
                  label="Removed"
                  value={(totals?.total_removed || 0).toLocaleString()}
                  color="danger"
                />
              </FlexItem>
              {(totals?.total_other || 0) > 0 && (
                <FlexItem>
                  <StatBox
                    label="Other"
                    value={(totals?.total_other || 0).toLocaleString()}
                    color="warning"
                  />
                </FlexItem>
              )}
            </Flex>
          </FlexItem>
        </Flex>

        <Toolbar>
          <ToolbarContent>
            <ToolbarItem>
              <ToggleGroup aria-label="History view mode">
                <ToggleGroupItem
                  text="Grouped"
                  isSelected={viewMode === "grouped"}
                  onChange={() => handleViewModeChange("grouped")}
                />
                <ToggleGroupItem
                  text="Flat"
                  isSelected={viewMode === "flat"}
                  onChange={() => handleViewModeChange("flat")}
                />
              </ToggleGroup>
            </ToolbarItem>
            <ToolbarItem>
              <SearchInput
                placeholder="Filter by package name..."
                value={searchInput}
                onChange={(_event, value) => setSearchInput(value)}
                onClear={() => setSearchInput("")}
                aria-label="Filter history by package name"
              />
            </ToolbarItem>
            <ToolbarItem>
              <Select
                toggle={(toggleRef) => (
                  <MenuToggle
                    ref={toggleRef}
                    onClick={() => setFilterOpen(!filterOpen)}
                    isExpanded={filterOpen}
                  >
                    {filter === "all" ? "All actions" : filter.charAt(0).toUpperCase() + filter.slice(1)}
                  </MenuToggle>
                )}
                onSelect={(_event, value) => handleFilterChange(value as HistoryFilterType)}
                selected={filter}
                isOpen={filterOpen}
                onOpenChange={(isOpen) => setFilterOpen(isOpen)}
              >
                <SelectOption value="all">All actions</SelectOption>
                <SelectOption value="upgraded">Upgraded</SelectOption>
                <SelectOption value="installed">Installed</SelectOption>
                <SelectOption value="removed">Removed</SelectOption>
              </Select>
            </ToolbarItem>
            {viewMode === "grouped" && (
              <ToolbarItem>
                <Button
                  variant="secondary"
                  onClick={toggleAllGroups}
                  isDisabled={!groupedData?.groups.length}
                >
                  {allExpanded ? "Collapse all" : "Expand all"}
                </Button>
              </ToolbarItem>
            )}
            <ToolbarItem variant="pagination" align={{ default: "alignEnd" }}>
              <CompactPagination
                itemCount={itemCount}
                perPage={perPage}
                page={page}
                onSetPage={onSetPage}
                onPerPageSelect={onPerPageSelect}
                perPageOptions={PER_PAGE_OPTIONS}
              />
            </ToolbarItem>
          </ToolbarContent>
        </Toolbar>

        {state === "loading" ? (
          <EmptyState headingLevel="h3" icon={Spinner} titleText="Loading history" />
        ) : state === "error" ? (
          <EmptyState headingLevel="h3" icon={ExclamationCircleIcon} titleText="Error loading history" status="danger">
            <EmptyStateBody>{sanitizeErrorMessage(error)}</EmptyStateBody>
            <EmptyStateFooter>
              <EmptyStateActions>
                <Button variant="primary" onClick={loadHistory}>Retry</Button>
              </EmptyStateActions>
            </EmptyStateFooter>
          </EmptyState>
        ) : !resultCount ? (
          <EmptyState headingLevel="h3" titleText="No matching entries">
            <EmptyStateBody>
              {searchQuery
                ? `No history found for "${searchQuery}"${filter !== "all" ? ` with filter "${filter}"` : ""}.`
                : `No ${filter} packages found in history.`}
            </EmptyStateBody>
          </EmptyState>
        ) : viewMode === "flat" ? (
          <>
            <Table aria-label="Package history (flat)" variant="compact">
              <Thead>
                <Tr>
                  <Th>Package</Th>
                  <Th>Version</Th>
                  <Th>Action</Th>
                  <Th>Time</Th>
                </Tr>
              </Thead>
              <Tbody>
                {flatData?.entries.map((entry: LogEntry, index: number) => renderEntryRow(entry, index))}
              </Tbody>
            </Table>

            <Pagination
              itemCount={itemCount}
              perPage={perPage}
              page={page}
              onSetPage={onSetPage}
              onPerPageSelect={onPerPageSelect}
              perPageOptions={PER_PAGE_OPTIONS}
              variant="bottom"
            />
          </>
        ) : (
          <>
            <Accordion asDefinitionList={false}>
              {groupedData?.groups.map((group: LogGroup) => (
                <AccordionItem key={group.id} isExpanded={expandedGroups.has(group.id)}>
                  <AccordionToggle
                    onClick={() => toggleGroup(group.id)}
                    id={`${group.id}-toggle`}
                  >
                    <Flex
                      justifyContent={{ default: "justifyContentSpaceBetween" }}
                      alignItems={{ default: "alignItemsCenter" }}
                      style={{ width: "100%" }}
                    >
                      <FlexItem>
                        <span style={{ fontWeight: 500 }}><TimeAgo timestamp={group.start_time} /></span>
                        {group.entries.length > 1 && (
                          <span style={{ color: "var(--pf-t--global--text--color--subtle)", marginLeft: "0.5rem" }}>
                            ({group.entries.length} packages)
                          </span>
                        )}
                      </FlexItem>
                      <FlexItem>
                        <Flex spaceItems={{ default: "spaceItemsSm" }}>
                          {renderGroupSummary(group)}
                        </Flex>
                      </FlexItem>
                    </Flex>
                  </AccordionToggle>
                  <AccordionContent id={`${group.id}-content`} hidden={!expandedGroups.has(group.id)}>
                    <Table aria-label={`Package history for ${group.id}`} variant="compact">
                      <Thead>
                        <Tr>
                          <Th>Package</Th>
                          <Th>Version</Th>
                          <Th>Action</Th>
                          <Th>Time</Th>
                        </Tr>
                      </Thead>
                      <Tbody>
                        {group.entries.map((entry: LogEntry, index: number) => renderEntryRow(entry, index))}
                      </Tbody>
                    </Table>
                  </AccordionContent>
                </AccordionItem>
              ))}
            </Accordion>

            <Pagination
              itemCount={itemCount}
              perPage={perPage}
              page={page}
              onSetPage={onSetPage}
              onPerPageSelect={onPerPageSelect}
              perPageOptions={PER_PAGE_OPTIONS}
              variant="bottom"
            />
          </>
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
