import React, { useState, useEffect, useCallback, useRef } from "react";
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
import { PackageDetailsModal } from "./PackageDetailsModal";
import { StatBox } from "./StatBox";
import { HistoryIcon, ArrowUpIcon, ArrowDownIcon, PlusIcon, MinusIcon } from "@patternfly/react-icons";
import { Table, Thead, Tr, Th, Tbody, Td } from "@patternfly/react-table";
import {
  LogEntry,
  LogGroup,
  GroupedLogResponse,
  HistoryFilterType,
  PackageDetails,
  SyncPackageDetails,
  getGroupedHistory,
  getPackageInfo,
  getSyncPackageInfo,
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

const PER_PAGE_OPTIONS = [
  { title: "10", value: 10 },
  { title: "20", value: 20 },
  { title: "50", value: 50 },
];

export const HistoryView: React.FC = () => {
  const [state, setState] = useState<ViewState>("loading");
  const [groupedData, setGroupedData] = useState<GroupedLogResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const { page, perPage, offset, setPage, setPerPage } = usePagination({ defaultPerPage: 20 });
  const [filter, setFilter] = useState<HistoryFilterType>("all");
  const [filterOpen, setFilterOpen] = useState(false);
  const [expandedGroups, setExpandedGroups] = useState<Set<string>>(new Set());
  const [selectedPackage, setSelectedPackage] = useState<PackageDetails | SyncPackageDetails | null>(null);
  const [detailsLoading, setDetailsLoading] = useState(false);
  const [detailsError, setDetailsError] = useState<string | null>(null);
  const isMountedRef = useRef(true);

  const loadHistory = useCallback(async () => {
    setState("loading");
    setError(null);
    try {
      const response = await getGroupedHistory({
        offset,
        limit: perPage,
        filter,
      });
      setGroupedData(response);
      setState("ready");
    } catch (ex) {
      setState("error");
      setError(ex instanceof Error ? ex.message : String(ex));
    }
  }, [offset, perPage, filter]);

  useEffect(() => {
    loadHistory();
  }, [loadHistory]);

  useEffect(() => {
    return () => {
      isMountedRef.current = false;
    };
  }, []);

  const handleRowClick = async (pkgName: string) => {
    setDetailsLoading(true);
    setDetailsError(null);
    setSelectedPackage(null);
    try {
      const details = await getPackageInfo(pkgName);
      if (!isMountedRef.current) return;
      setSelectedPackage(details);
    } catch {
      if (!isMountedRef.current) return;
      try {
        const syncDetails = await getSyncPackageInfo(pkgName);
        if (!isMountedRef.current) return;
        setSelectedPackage(syncDetails);
      } catch {
        if (!isMountedRef.current) return;
        setDetailsError(`Package "${pkgName}" is not installed and not available in any configured repository.`);
      }
    } finally {
      if (isMountedRef.current) {
        setDetailsLoading(false);
      }
    }
  };

  const handleFilterChange = (value: HistoryFilterType) => {
    setFilter(value);
    setPage(1);
    setFilterOpen(false);
    setExpandedGroups(new Set());
  };

  const handleSetPage = (_event: React.MouseEvent | React.KeyboardEvent | MouseEvent, newPage: number) => {
    setPage(newPage);
    setExpandedGroups(new Set());
  };

  const handlePerPageSelect = (_event: React.MouseEvent | React.KeyboardEvent | MouseEvent, newPerPage: number) => {
    setPerPage(newPerPage);
    setPage(1);
    setExpandedGroups(new Set());
  };

  const toggleGroup = (groupId: string) => {
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

  const formatTimestamp = (timestamp: string): string => {
    try {
      // Handle ISO 8601 timestamps with timezone offsets like +0100, -0500, +0000
      // Convert compact offset (+0100) to colon format (+01:00) for better browser support
      const normalized = timestamp.replace(/([+-])(\d{2})(\d{2})$/, "$1$2:$3");
      const date = new Date(normalized);
      if (isNaN(date.getTime())) {
        return timestamp;
      }
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

  if (!groupedData?.groups.length && filter === "all") {
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
                <StatBox
                  label="Upgraded"
                  value={formatNumber(groupedData?.total_upgraded || 0)}
                  color="info"
                />
              </FlexItem>
              <FlexItem>
                <StatBox
                  label="Installed"
                  value={formatNumber(groupedData?.total_installed || 0)}
                  color="success"
                />
              </FlexItem>
              <FlexItem>
                <StatBox
                  label="Removed"
                  value={formatNumber(groupedData?.total_removed || 0)}
                  color="danger"
                />
              </FlexItem>
              {(groupedData?.total_other || 0) > 0 && (
                <FlexItem>
                  <StatBox
                    label="Other"
                    value={formatNumber(groupedData?.total_other || 0)}
                    color="warning"
                  />
                </FlexItem>
              )}
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

        {!groupedData?.groups.length ? (
          <EmptyState headingLevel="h3" titleText="No matching entries">
            <EmptyStateBody>
              No {filter} packages found in history.
            </EmptyStateBody>
          </EmptyState>
        ) : (
          <>
            <Accordion asDefinitionList={false}>
              {groupedData.groups.map((group: LogGroup) => (
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
                        <span style={{ fontWeight: 500 }}>{formatTimestamp(group.start_time)}</span>
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
                        {group.entries.map((entry: LogEntry, index: number) => (
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
                  </AccordionContent>
                </AccordionItem>
              ))}
            </Accordion>

            <Pagination
              itemCount={groupedData?.total_groups || 0}
              perPage={perPage}
              page={page}
              onSetPage={handleSetPage}
              onPerPageSelect={handlePerPageSelect}
              perPageOptions={PER_PAGE_OPTIONS}
              variant="bottom"
            />
          </>
        )}

        <PackageDetailsModal
          packageDetails={selectedPackage}
          isLoading={detailsLoading}
          onClose={() => {
            setSelectedPackage(null);
            setDetailsError(null);
          }}
          error={detailsError}
        />
      </CardBody>
    </Card>
  );
};
