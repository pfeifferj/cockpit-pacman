import React, { useState, useEffect, useCallback } from "react";
import { PER_PAGE_OPTIONS } from "../constants";
import {
  Card,
  CardBody,
  CardTitle,
  Button,
  Alert,
  EmptyState,
  EmptyStateBody,
  EmptyStateActions,
  EmptyStateFooter,
  Spinner,
  Flex,
  FlexItem,
  Label,
  Pagination,
  MenuToggle,
  Select,
  SelectOption,
} from "@patternfly/react-core";
import { HistoryIcon, ArrowUpIcon, ArrowDownIcon, PlusIcon, MinusIcon } from "@patternfly/react-icons";
import { Table, Thead, Tr, Th, Tbody, Td, ThProps } from "@patternfly/react-table";
import {
  LogEntry,
  LogResponse,
  HistoryFilterType,
  getHistory,
  formatNumber,
} from "../api";
import { sanitizeErrorMessage } from "../utils";

type ViewState = "loading" | "ready" | "error";

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

export const HistoryView: React.FC = () => {
  const [state, setState] = useState<ViewState>("loading");
  const [historyData, setHistoryData] = useState<LogResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [page, setPage] = useState(1);
  const [perPage, setPerPage] = useState(50);
  const [filter, setFilter] = useState<HistoryFilterType>("all");
  const [filterOpen, setFilterOpen] = useState(false);
  const [activeSortIndex, setActiveSortIndex] = useState<number | null>(null);
  const [activeSortDirection, setActiveSortDirection] = useState<"asc" | "desc">("asc");

  const loadHistory = useCallback(async () => {
    setState("loading");
    setError(null);
    try {
      const response = await getHistory({
        offset: (page - 1) * perPage,
        limit: perPage,
        filter,
      });
      setHistoryData(response);
      setState("ready");
    } catch (ex) {
      setState("error");
      setError(ex instanceof Error ? ex.message : String(ex));
    }
  }, [page, perPage, filter]);

  useEffect(() => {
    loadHistory();
  }, [loadHistory]);

  const handleFilterChange = (value: HistoryFilterType) => {
    setFilter(value);
    setPage(1);
    setFilterOpen(false);
  };

  const handleSetPage = (_event: React.MouseEvent | React.KeyboardEvent | MouseEvent, newPage: number) => {
    setPage(newPage);
  };

  const handlePerPageSelect = (_event: React.MouseEvent | React.KeyboardEvent | MouseEvent, newPerPage: number) => {
    setPerPage(newPerPage);
    setPage(1);
  };

  const sortableColumns = [0, 2, 3];

  const getSortParams = (columnIndex: number): ThProps["sort"] | undefined => {
    if (!sortableColumns.includes(columnIndex)) return undefined;
    return {
      sortBy: {
        index: activeSortIndex ?? undefined,
        direction: activeSortDirection,
        defaultDirection: "asc",
      },
      onSort: (_event, index, direction) => {
        setActiveSortIndex(index);
        setActiveSortDirection(direction);
      },
      columnIndex,
    };
  };

  const sortedEntries = React.useMemo(() => {
    if (!historyData?.entries) return [];
    return [...historyData.entries].sort((a, b) => {
      if (activeSortIndex === null) return 0;
      let comparison = 0;
      switch (activeSortIndex) {
        case 0:
          comparison = a.package.localeCompare(b.package);
          break;
        case 2:
          comparison = a.action.localeCompare(b.action);
          break;
        case 3:
          comparison = a.timestamp.localeCompare(b.timestamp);
          break;
        default:
          return 0;
      }
      return activeSortDirection === "asc" ? comparison : -comparison;
    });
  }, [historyData, activeSortIndex, activeSortDirection]);

  const formatTimestamp = (timestamp: string): string => {
    try {
      const date = new Date(timestamp.replace("+0000", "Z").replace(" ", "T"));
      return date.toLocaleString();
    } catch {
      return timestamp;
    }
  };

  const formatVersion = (entry: LogEntry): string => {
    if (entry.old_version && entry.new_version) {
      return `${entry.old_version} -> ${entry.new_version}`;
    }
    return entry.old_version || entry.new_version || "";
  };

  if (state === "loading") {
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

  if (state === "error") {
    return (
      <Card>
        <CardBody>
          <Alert variant="danger" title="Error loading history">
            {sanitizeErrorMessage(error)}
          </Alert>
          <div className="pf-v6-u-mt-md">
            <Button variant="primary" onClick={loadHistory}>
              Retry
            </Button>
          </div>
        </CardBody>
      </Card>
    );
  }

  if (!historyData?.entries.length && filter === "all") {
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
            <CardTitle className="pf-v6-u-m-0 pf-v6-u-mb-md">Package History</CardTitle>
            <Flex spaceItems={{ default: "spaceItemsLg" }} className="pf-v6-u-mb-md">
              <FlexItem>
                <div style={{ textAlign: "center", padding: "0.75rem 1.5rem", background: "var(--pf-t--global--background--color--secondary--default)", borderRadius: "6px" }}>
                  <div style={{ fontSize: "1.5rem", fontWeight: 600, color: "var(--pf-t--global--color--status--info--default)" }}>{formatNumber(historyData?.total_upgraded || 0)}</div>
                  <div style={{ fontSize: "0.75rem", color: "var(--pf-t--global--text--color--subtle)", textTransform: "uppercase" }}>Upgraded</div>
                </div>
              </FlexItem>
              <FlexItem>
                <div style={{ textAlign: "center", padding: "0.75rem 1.5rem", background: "var(--pf-t--global--background--color--secondary--default)", borderRadius: "6px" }}>
                  <div style={{ fontSize: "1.5rem", fontWeight: 600, color: "var(--pf-t--global--color--status--success--default)" }}>{formatNumber(historyData?.total_installed || 0)}</div>
                  <div style={{ fontSize: "0.75rem", color: "var(--pf-t--global--text--color--subtle)", textTransform: "uppercase" }}>Installed</div>
                </div>
              </FlexItem>
              <FlexItem>
                <div style={{ textAlign: "center", padding: "0.75rem 1.5rem", background: "var(--pf-t--global--background--color--secondary--default)", borderRadius: "6px" }}>
                  <div style={{ fontSize: "1.5rem", fontWeight: 600, color: "var(--pf-t--global--color--status--danger--default)" }}>{formatNumber(historyData?.total_removed || 0)}</div>
                  <div style={{ fontSize: "0.75rem", color: "var(--pf-t--global--text--color--subtle)", textTransform: "uppercase" }}>Removed</div>
                </div>
              </FlexItem>
            </Flex>
          </FlexItem>
          <FlexItem>
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
          </FlexItem>
        </Flex>

        {!historyData?.entries.length ? (
          <EmptyState headingLevel="h3" titleText="No matching entries">
            <EmptyStateBody>
              No {filter} packages found in history.
            </EmptyStateBody>
          </EmptyState>
        ) : (
          <>
            <Table aria-label="Package history" variant="compact">
              <Thead>
                <Tr>
                  <Th sort={getSortParams(0)}>Package</Th>
                  <Th>Version</Th>
                  <Th sort={getSortParams(2)}>Action</Th>
                  <Th sort={getSortParams(3)}>Time</Th>
                </Tr>
              </Thead>
              <Tbody>
                {sortedEntries.map((entry: LogEntry, index: number) => (
                  <Tr key={`${entry.timestamp}-${entry.package}-${index}`}>
                    <Td dataLabel="Package">{entry.package}</Td>
                    <Td dataLabel="Version">
                      <code>{formatVersion(entry)}</code>
                    </Td>
                    <Td dataLabel="Action">
                      <Label
                        color={ACTION_COLORS[entry.action] || "grey"}
                        icon={ACTION_ICONS[entry.action]}
                      >
                        {entry.action}
                      </Label>
                    </Td>
                    <Td dataLabel="Time">{formatTimestamp(entry.timestamp)}</Td>
                  </Tr>
                ))}
              </Tbody>
            </Table>

            <Pagination
              itemCount={historyData?.total || 0}
              perPage={perPage}
              page={page}
              onSetPage={handleSetPage}
              onPerPageSelect={handlePerPageSelect}
              perPageOptions={PER_PAGE_OPTIONS}
              variant="bottom"
            />
          </>
        )}
      </CardBody>
    </Card>
  );
};
