import React, { useState, useEffect, useCallback, useRef, useMemo } from "react";
import { useBackdropClose } from "../hooks/useBackdropClose";
import { LOG_CONTAINER_HEIGHT, MAX_LOG_SIZE_BYTES } from "../constants";
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
  CodeBlock,
  CodeBlockCode,
  Flex,
  FlexItem,
  ExpandableSection,
  Modal,
  ModalVariant,
  ModalHeader,
  ModalBody,
  ModalFooter,
  Content,
  ContentVariants,
  SearchInput,
  Toolbar,
  ToolbarContent,
  ToolbarItem,
  Switch,
  MenuToggle,
  Select,
  SelectOption,
  SelectList,
  Form,
  FormGroup,
  FormSelect,
  FormSelectOption,
  NumberInput,
  Checkbox,
} from "@patternfly/react-core";
import {
  GlobeIcon,
  CheckCircleIcon,
  TimesCircleIcon,
  ArrowUpIcon,
  ArrowDownIcon,
  SyncAltIcon,
  OutlinedClockIcon,
  ExclamationCircleIcon,
  HistoryIcon,
  UndoIcon,
  TrashIcon,
} from "@patternfly/react-icons";
import { Table, Thead, Tr, Th, Tbody, Td, ThProps } from "@patternfly/react-table";
import { StatBox } from "./StatBox";
import {
  MirrorEntry,
  MirrorListResponse,
  MirrorStatus,
  MirrorStatusResponse,
  MirrorTestResult,
  RefreshMirrorsResponse,
  RefreshMirrorsProtocol,
  RefreshMirrorsSortBy,
  MirrorBackup,
  listMirrors,
  fetchMirrorStatus,
  testMirrors,
  saveMirrorlist,
  refreshMirrors,
  listMirrorBackups,
  restoreMirrorBackup,
  deleteMirrorBackup,
  formatNumber,
  formatDate,
  formatSize,
} from "../api";
import { sanitizeErrorMessage } from "../utils";

type ViewState = "loading" | "ready" | "testing" | "saving" | "fetching_status" | "success" | "error";

interface MirrorWithStatus extends MirrorEntry {
  status?: MirrorStatus;
  testResult?: MirrorTestResult;
}

const STATUS_CACHE_KEY = "cockpit-pacman-mirror-status";
const STATUS_CACHE_TTL_MS = 60 * 60 * 1000; // 1 hour

interface CachedMirrorStatus {
  data: MirrorStatusResponse;
  timestamp: number;
}

function isValidCachedStatus(obj: unknown): obj is CachedMirrorStatus {
  if (typeof obj !== "object" || obj === null) return false;
  const record = obj as Record<string, unknown>;
  if (typeof record.timestamp !== "number") return false;
  if (typeof record.data !== "object" || record.data === null) return false;
  const data = record.data as Record<string, unknown>;
  if (typeof data.total !== "number") return false;
  if (!Array.isArray(data.mirrors)) return false;
  return true;
}

function getCachedStatus(): MirrorStatusResponse | null {
  try {
    const cached = window.localStorage.getItem(STATUS_CACHE_KEY);
    if (!cached) return null;
    const parsed: unknown = JSON.parse(cached);
    if (!isValidCachedStatus(parsed)) {
      window.localStorage.removeItem(STATUS_CACHE_KEY);
      return null;
    }
    if (Date.now() - parsed.timestamp > STATUS_CACHE_TTL_MS) {
      window.localStorage.removeItem(STATUS_CACHE_KEY);
      return null;
    }
    return parsed.data;
  } catch {
    window.localStorage.removeItem(STATUS_CACHE_KEY);
    return null;
  }
}

function setCachedStatus(data: MirrorStatusResponse): void {
  try {
    const cached: CachedMirrorStatus = { data, timestamp: Date.now() };
    window.localStorage.setItem(STATUS_CACHE_KEY, JSON.stringify(cached));
  } catch {
    // Ignore storage errors
  }
}

function getCacheAge(): number | null {
  try {
    const cached = window.localStorage.getItem(STATUS_CACHE_KEY);
    if (!cached) return null;
    const parsed: CachedMirrorStatus = JSON.parse(cached);
    return Date.now() - parsed.timestamp;
  } catch {
    return null;
  }
}

function formatCacheAge(ms: number): string {
  const minutes = Math.floor(ms / 60000);
  if (minutes < 1) return "just now";
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  return `${days}d ago`;
}

function normalizeMirrorUrl(url: string): string {
  let normalized = url
    .replace(/\$repo\/os\/\$arch\/?$/, "")
    .replace(/\$arch\/?$/, "")
    .replace(/\$repo\/?$/, "");

  // Clean up any resulting double slashes (except in protocol)
  normalized = normalized.replace(/(https?:\/\/)|\/+/g, (match, protocol) =>
    protocol ? protocol : "/"
  );

  // Ensure single trailing slash
  return normalized.replace(/\/*$/, "") + "/";
}

export const MirrorsView: React.FC = () => {
  const [state, setState] = useState<ViewState>("loading");
  const [mirrorData, setMirrorData] = useState<MirrorListResponse | null>(null);
  const [mirrors, setMirrors] = useState<MirrorWithStatus[]>([]);
  const [statusData, setStatusData] = useState<MirrorStatusResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [log, setLog] = useState("");
  const [isDetailsExpanded, setIsDetailsExpanded] = useState(false);
  const [confirmModalOpen, setConfirmModalOpen] = useState(false);
  useBackdropClose(confirmModalOpen, () => setConfirmModalOpen(false));
  const [hasChanges, setHasChanges] = useState(false);
  const [searchFilter, setSearchFilter] = useState("");
  const [countryFilter, setCountryFilter] = useState<string>("all");
  const [countryFilterOpen, setCountryFilterOpen] = useState(false);
  const [activeSortIndex, setActiveSortIndex] = useState<number | null>(null);
  const [activeSortDirection, setActiveSortDirection] = useState<"asc" | "desc">("asc");
  const [refreshModalOpen, setRefreshModalOpen] = useState(false);
  const [refreshLoading, setRefreshLoading] = useState(false);
  const [refreshPreview, setRefreshPreview] = useState<RefreshMirrorsResponse | null>(null);
  const [refreshCount, setRefreshCount] = useState(20);
  const [refreshCountry, setRefreshCountry] = useState("");
  const [refreshProtocol, setRefreshProtocol] = useState<RefreshMirrorsProtocol>("https");
  const [refreshSortBy, setRefreshSortBy] = useState<RefreshMirrorsSortBy>("score");
  const [refreshError, setRefreshError] = useState<string | null>(null);
  useBackdropClose(refreshModalOpen, () => { if (!refreshLoading) setRefreshModalOpen(false); });
  const [backups, setBackups] = useState<MirrorBackup[]>([]);
  const [backupsExpanded, setBackupsExpanded] = useState(false);
  const [backupsLoading, setBackupsLoading] = useState(false);
  const [restoringTimestamp, setRestoringTimestamp] = useState<number | null>(null);
  const [selectedBackups, setSelectedBackups] = useState<Set<number>>(new Set());
  const [deletingBackups, setDeletingBackups] = useState(false);
  const [restoreConfirmTimestamp, setRestoreConfirmTimestamp] = useState<number | null>(null);
  useBackdropClose(restoreConfirmTimestamp !== null, () => setRestoreConfirmTimestamp(null));
  const cancelRef = useRef<(() => void) | null>(null);
  const logContainerRef = useRef<HTMLDivElement | null>(null);
  const initialStatusFetchedRef = useRef(false);

  const applyStatusToMirrors = useCallback((mirrorList: MirrorEntry[], status: MirrorStatusResponse): MirrorWithStatus[] => {
    const statusByUrl = new Map(status.mirrors.map(s => [normalizeMirrorUrl(s.url), s]));
    return mirrorList.map(m => ({
      ...m,
      status: statusByUrl.get(normalizeMirrorUrl(m.url)),
    }));
  }, []);

  const loadMirrors = useCallback(async () => {
    setState("loading");
    setError(null);
    try {
      const response = await listMirrors();
      setMirrorData(response);

      const cachedStatus = getCachedStatus();
      if (cachedStatus) {
        setStatusData(cachedStatus);
        setMirrors(applyStatusToMirrors(response.mirrors, cachedStatus));
      } else {
        setMirrors(response.mirrors.map(m => ({ ...m })));
      }

      setHasChanges(false);
      setState("ready");
    } catch (ex) {
      setState("error");
      setError(ex instanceof Error ? ex.message : String(ex));
    }
  }, [applyStatusToMirrors]);

  useEffect(() => {
    loadMirrors();
  }, [loadMirrors]);

  useEffect(() => {
    return () => {
      if (cancelRef.current) {
        cancelRef.current();
      }
    };
  }, []);

  useEffect(() => {
    if (logContainerRef.current) {
      logContainerRef.current.scrollTop = logContainerRef.current.scrollHeight;
    }
  }, [log]);

  useEffect(() => {
    if (state === "ready" && !statusData && !initialStatusFetchedRef.current) {
      initialStatusFetchedRef.current = true;
      handleFetchStatus(false);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [state, statusData]);

  const handleFetchStatus = async (forceRefresh = false) => {
    if (!forceRefresh) {
      const cached = getCachedStatus();
      if (cached) {
        setStatusData(cached);
        setMirrors(prev => applyStatusToMirrors(prev, cached));
        return;
      }
    }

    setState("fetching_status");
    setError(null);
    try {
      const response = await fetchMirrorStatus();
      setCachedStatus(response);
      setStatusData(response);
      setMirrors(prev => applyStatusToMirrors(prev, response));
      setState("ready");
    } catch (ex) {
      setState("error");
      setError(ex instanceof Error ? ex.message : String(ex));
    }
  };

  const loadBackups = useCallback(async () => {
    setBackupsLoading(true);
    try {
      const response = await listMirrorBackups();
      setBackups(response.backups);
    } catch {
      setBackups([]);
    } finally {
      setBackupsLoading(false);
    }
  }, []);

  const handleBackupsToggle = (_event: React.MouseEvent | undefined, expanded: boolean) => {
    setBackupsExpanded(expanded);
    if (expanded && backups.length === 0) {
      loadBackups();
    }
  };

  const handleRestore = async (timestamp: number) => {
    setRestoreConfirmTimestamp(null);
    setRestoringTimestamp(timestamp);
    setError(null);
    try {
      await restoreMirrorBackup(timestamp);
      await loadMirrors();
      await loadBackups();
    } catch (ex) {
      setError(ex instanceof Error ? ex.message : String(ex));
    } finally {
      setRestoringTimestamp(null);
    }
  };

  const toggleBackupSelection = (timestamp: number) => {
    setSelectedBackups(prev => {
      const next = new Set(prev);
      if (next.has(timestamp)) next.delete(timestamp);
      else next.add(timestamp);
      return next;
    });
  };

  const selectAllBackups = () => setSelectedBackups(new Set(backups.map(b => b.timestamp)));
  const deselectAllBackups = () => setSelectedBackups(new Set());
  const allBackupsSelected = backups.length > 0 && selectedBackups.size === backups.length;
  const someBackupsSelected = selectedBackups.size > 0 && selectedBackups.size < backups.length;

  const handleDeleteSelected = async () => {
    if (selectedBackups.size === 0) return;
    setDeletingBackups(true);
    const results = await Promise.allSettled(
      Array.from(selectedBackups).map(ts => deleteMirrorBackup(ts))
    );
    const failed = results.filter(r => r.status === "rejected").length;
    if (failed > 0) {
      setError(`Failed to delete ${failed} of ${selectedBackups.size} backup${selectedBackups.size !== 1 ? "s" : ""}`);
    }
    await loadBackups();
    setSelectedBackups(new Set());
    setDeletingBackups(false);
  };

  const handleTestMirrors = () => {
    const enabledMirrors = mirrors.filter(m => m.enabled).map(m => m.url);
    if (enabledMirrors.length === 0) {
      setError("No enabled mirrors to test");
      return;
    }

    setState("testing");
    setLog("");
    setIsDetailsExpanded(true);

    const { cancel } = testMirrors(
      {
        onTestResult: (result, current, total) => {
          setMirrors(prev => prev.map(m =>
            m.url === result.url ? { ...m, testResult: result } : m
          ));
          setLog(prev => {
            const newLog = prev + `[${current}/${total}] ${result.url}: ${result.success ? `${result.latency_ms}ms` : result.error}\n`;
            return newLog.length > MAX_LOG_SIZE_BYTES ? newLog.slice(-MAX_LOG_SIZE_BYTES) : newLog;
          });
        },
        onComplete: () => {
          setState("ready");
          cancelRef.current = null;
          setMirrors(prev => {
            const sorted = [...prev].sort((a, b) => {
              if (!a.testResult?.success && !b.testResult?.success) return 0;
              if (!a.testResult?.success) return 1;
              if (!b.testResult?.success) return -1;
              return (a.testResult.latency_ms ?? Infinity) - (b.testResult.latency_ms ?? Infinity);
            });
            return sorted;
          });
          setHasChanges(true);
        },
        onError: (err) => {
          setState("error");
          setError(err);
          cancelRef.current = null;
        },
        timeout: 120,
      },
      enabledMirrors
    );
    cancelRef.current = cancel;
  };

  const handleCancel = () => {
    if (cancelRef.current) {
      cancelRef.current();
      cancelRef.current = null;
      setState("ready");
    }
  };

  const handleSave = () => {
    setConfirmModalOpen(true);
  };

  const startSave = async () => {
    setConfirmModalOpen(false);
    setState("saving");
    try {
      const mirrorsToSave: MirrorEntry[] = mirrors.map(({ url, enabled, comment }) => ({
        url,
        enabled,
        comment,
      }));
      await saveMirrorlist(mirrorsToSave);
      setState("success");
      setHasChanges(false);
    } catch (ex) {
      setState("error");
      setError(ex instanceof Error ? ex.message : String(ex));
    }
  };

  const handleToggleEnabled = (url: string) => {
    setMirrors(prev => prev.map(m =>
      m.url === url ? { ...m, enabled: !m.enabled } : m
    ));
    setHasChanges(true);
  };

  const handleMoveUp = (index: number) => {
    if (index <= 0) return;
    setMirrors(prev => {
      const newMirrors = [...prev];
      [newMirrors[index - 1], newMirrors[index]] = [newMirrors[index], newMirrors[index - 1]];
      return newMirrors;
    });
    setHasChanges(true);
  };

  const handleMoveDown = (index: number) => {
    if (index >= mirrors.length - 1) return;
    setMirrors(prev => {
      const newMirrors = [...prev];
      [newMirrors[index], newMirrors[index + 1]] = [newMirrors[index + 1], newMirrors[index]];
      return newMirrors;
    });
    setHasChanges(true);
  };

  const handleOpenRefreshModal = () => {
    setRefreshPreview(null);
    setRefreshError(null);
    setRefreshModalOpen(true);
  };

  const handleRefreshGenerate = async () => {
    setRefreshLoading(true);
    setRefreshPreview(null);
    setRefreshError(null);
    try {
      const result = await refreshMirrors({
        count: refreshCount,
        country: refreshCountry || undefined,
        protocol: refreshProtocol,
        sortBy: refreshSortBy,
      });
      setRefreshPreview(result);
    } catch (ex) {
      setRefreshError(ex instanceof Error ? ex.message : String(ex));
    } finally {
      setRefreshLoading(false);
    }
  };

  const handleRefreshApply = () => {
    if (!refreshPreview) return;
    const newMirrors: MirrorWithStatus[] = refreshPreview.mirrors.map(m => ({
      ...m,
    }));
    setMirrors(newMirrors);
    setHasChanges(true);
    setRefreshModalOpen(false);
    setRefreshPreview(null);
  };

  const countries = useMemo(() => {
    const countrySet = new Set<string>();
    for (const m of mirrors) {
      if (m.status?.country) {
        countrySet.add(m.status.country);
      }
    }
    return Array.from(countrySet).sort();
  }, [mirrors]);

  const statusCountries = useMemo(() => {
    if (!statusData) return [];
    const countryMap = new Map<string, string>();
    for (const m of statusData.mirrors) {
      if (m.country && m.country_code) {
        countryMap.set(m.country_code, m.country);
      }
    }
    return Array.from(countryMap.entries())
      .sort((a, b) => a[1].localeCompare(b[1]));
  }, [statusData]);

  // O(1) lookup map for mirror indices
  const mirrorIndexMap = useMemo(() => {
    const map = new Map<string, number>();
    mirrors.forEach((m, i) => map.set(m.url, i));
    return map;
  }, [mirrors]);

  const filteredMirrors = useMemo(() => {
    return mirrors.filter(m => {
      if (searchFilter && !m.url.toLowerCase().includes(searchFilter.toLowerCase())) {
        return false;
      }
      if (countryFilter !== "all" && m.status?.country !== countryFilter) {
        return false;
      }
      return true;
    });
  }, [mirrors, searchFilter, countryFilter]);

  const sortedMirrors = useMemo(() => {
    if (activeSortIndex === null) return filteredMirrors;
    return [...filteredMirrors].sort((a, b) => {
      let comparison = 0;
      switch (activeSortIndex) {
        case 0:
          comparison = (a.enabled ? 0 : 1) - (b.enabled ? 0 : 1);
          break;
        case 1:
          comparison = a.url.localeCompare(b.url);
          break;
        case 2:
          comparison = (a.status?.country || "").localeCompare(b.status?.country || "");
          break;
        case 3:
          comparison = (a.testResult?.latency_ms ?? Infinity) - (b.testResult?.latency_ms ?? Infinity);
          break;
        case 4:
          comparison = (a.status?.score ?? Infinity) - (b.status?.score ?? Infinity);
          break;
        default:
          return 0;
      }
      return activeSortDirection === "asc" ? comparison : -comparison;
    });
  }, [filteredMirrors, activeSortIndex, activeSortDirection]);

  const getSortParams = (columnIndex: number): ThProps["sort"] | undefined => {
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


  if (state === "loading") {
    return (
      <Card>
        <CardBody>
          <EmptyState headingLevel="h2" icon={Spinner} titleText="Loading mirrors">
            <EmptyStateBody>Reading mirrorlist configuration...</EmptyStateBody>
          </EmptyState>
        </CardBody>
      </Card>
    );
  }

  if (state === "error" && !mirrorData) {
    return (
      <Card>
        <CardBody>
          <EmptyState headingLevel="h2" icon={ExclamationCircleIcon} titleText="Error loading mirrors" status="danger">
            <EmptyStateBody>{sanitizeErrorMessage(error)}</EmptyStateBody>
            <EmptyStateFooter>
              <EmptyStateActions>
                <Button variant="primary" onClick={loadMirrors}>Retry</Button>
              </EmptyStateActions>
            </EmptyStateFooter>
          </EmptyState>
        </CardBody>
      </Card>
    );
  }

  if (state === "testing") {
    return (
      <Card>
        <CardBody>
          <Flex justifyContent={{ default: "justifyContentSpaceBetween" }} alignItems={{ default: "alignItemsCenter" }}>
            <FlexItem>
              <CardTitle className="pf-v6-u-m-0">Testing Mirrors</CardTitle>
            </FlexItem>
            <FlexItem>
              <Button variant="danger" onClick={handleCancel}>
                Cancel
              </Button>
            </FlexItem>
          </Flex>

          <div className="pf-v6-u-mt-md pf-v6-u-mb-md">
            <Spinner size="md" /> Testing mirror latency...
          </div>

          <ExpandableSection
            toggleText={isDetailsExpanded ? "Hide details" : "Show details"}
            onToggle={(_event, expanded) => setIsDetailsExpanded(expanded)}
            isExpanded={isDetailsExpanded}
          >
            <div ref={logContainerRef} style={{ maxHeight: LOG_CONTAINER_HEIGHT, overflow: "auto" }}>
              <CodeBlock>
                <CodeBlockCode>{log || "Starting tests..."}</CodeBlockCode>
              </CodeBlock>
            </div>
          </ExpandableSection>
        </CardBody>
      </Card>
    );
  }

  if (state === "fetching_status") {
    return (
      <Card>
        <CardBody>
          <EmptyState headingLevel="h2" icon={Spinner} titleText="Fetching mirror status">
            <EmptyStateBody>Retrieving mirror information from archlinux.org...</EmptyStateBody>
          </EmptyState>
        </CardBody>
      </Card>
    );
  }

  if (state === "saving") {
    return (
      <Card>
        <CardBody>
          <EmptyState headingLevel="h2" icon={Spinner} titleText="Saving mirrorlist">
            <EmptyStateBody>Writing mirror configuration...</EmptyStateBody>
          </EmptyState>
        </CardBody>
      </Card>
    );
  }

  if (state === "success") {
    return (
      <Card>
        <CardBody>
          <EmptyState headingLevel="h2" icon={CheckCircleIcon} titleText="Mirrorlist saved">
            <EmptyStateBody>
              The mirrorlist has been saved. A backup was created.
            </EmptyStateBody>
            <EmptyStateFooter>
              <EmptyStateActions>
                <Button variant="primary" onClick={loadMirrors}>
                  View Mirrors
                </Button>
              </EmptyStateActions>
            </EmptyStateFooter>
          </EmptyState>
        </CardBody>
      </Card>
    );
  }

  if (!mirrors.length) {
    return (
      <Card>
        <CardBody>
          <EmptyState headingLevel="h2" icon={GlobeIcon} titleText="No mirrors found">
            <EmptyStateBody>
              The mirrorlist at {mirrorData?.path || "/etc/pacman.d/mirrorlist"} contains no mirrors.
            </EmptyStateBody>
            <EmptyStateFooter>
              <EmptyStateActions>
                <Button variant="secondary" onClick={loadMirrors}>
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
        {error && (
          <Alert variant="warning" title="Error" isInline className="pf-v6-u-mb-md">
            {sanitizeErrorMessage(error)}
          </Alert>
        )}

        <Flex justifyContent={{ default: "justifyContentSpaceBetween" }} alignItems={{ default: "alignItemsFlexStart" }}>
          <FlexItem>
            <CardTitle className="pf-v6-u-m-0">Pacman Mirrors</CardTitle>
            <Flex spaceItems={{ default: "spaceItemsLg" }} className="pf-v6-u-mb-md pf-v6-u-mt-sm">
              <FlexItem>
                <StatBox label="Total" value={formatNumber(mirrors.length)} />
              </FlexItem>
              <FlexItem>
                <StatBox label="Enabled" value={formatNumber(mirrors.filter(m => m.enabled).length)} color="success" />
              </FlexItem>
              {mirrorData?.last_modified && (
                <FlexItem>
                  <StatBox label="Last Modified" value={formatDate(mirrorData.last_modified)} />
                </FlexItem>
              )}
            </Flex>
          </FlexItem>
        </Flex>

        <Toolbar>
          <ToolbarContent>
            <ToolbarItem>
              <SearchInput
                placeholder="Search mirrors..."
                value={searchFilter}
                onChange={(_event: React.SyntheticEvent, value: string) => setSearchFilter(value)}
                onClear={() => setSearchFilter("")}
                aria-label="Search mirrors"
              />
            </ToolbarItem>
            {countries.length > 0 && (
              <ToolbarItem>
                <Select
                  toggle={(toggleRef) => (
                    <MenuToggle
                      ref={toggleRef}
                      onClick={() => setCountryFilterOpen(!countryFilterOpen)}
                      isExpanded={countryFilterOpen}
                      style={{ minWidth: "150px" }}
                    >
                      {countryFilter === "all" ? "All Countries" : countryFilter}
                    </MenuToggle>
                  )}
                  onSelect={(_event, value) => {
                    setCountryFilter(value as string);
                    setCountryFilterOpen(false);
                  }}
                  selected={countryFilter}
                  isOpen={countryFilterOpen}
                  onOpenChange={setCountryFilterOpen}
                >
                  <SelectList>
                    <SelectOption value="all">All Countries</SelectOption>
                    {countries.map(country => (
                      <SelectOption key={country} value={country}>
                        {country}
                      </SelectOption>
                    ))}
                  </SelectList>
                </Select>
              </ToolbarItem>
            )}
            <ToolbarItem>
              <Button
                variant="secondary"
                icon={<SyncAltIcon />}
                onClick={() => handleFetchStatus(true)}
                isDisabled={state !== "ready"}
              >
                {statusData ? "Refresh Status" : "Fetch Status"}
              </Button>
            </ToolbarItem>
            <ToolbarItem>
              <Button
                variant="secondary"
                icon={<OutlinedClockIcon />}
                onClick={handleTestMirrors}
                isDisabled={state !== "ready" || mirrors.filter(m => m.enabled).length === 0}
              >
                Test Mirrors
              </Button>
            </ToolbarItem>
            <ToolbarItem>
              <Button
                variant="secondary"
                icon={<GlobeIcon />}
                onClick={handleOpenRefreshModal}
                isDisabled={state !== "ready"}
              >
                Refresh Mirrorlist
              </Button>
            </ToolbarItem>
            <ToolbarItem>
              <Button
                variant="primary"
                onClick={handleSave}
                isDisabled={!hasChanges || state !== "ready"}
              >
                Save Changes
              </Button>
            </ToolbarItem>
          </ToolbarContent>
        </Toolbar>

        <Table aria-label="Mirror list" variant="compact">
          <Thead>
            <Tr>
              <Th sort={getSortParams(0)} width={10}>Enabled</Th>
              <Th sort={getSortParams(1)}>URL</Th>
              <Th sort={getSortParams(2)} width={15}>Country</Th>
              <Th sort={getSortParams(3)} width={10}>Latency</Th>
              <Th sort={getSortParams(4)} width={10}>Score</Th>
              <Th width={10}>Actions</Th>
            </Tr>
          </Thead>
          <Tbody>
            {sortedMirrors.map((mirror) => {
              const actualIndex = mirrorIndexMap.get(mirror.url) ?? -1;
              return (
                <Tr key={mirror.url}>
                  <Td dataLabel="Enabled">
                    <Switch
                      id={`switch-${actualIndex}`}
                      isChecked={mirror.enabled}
                      onChange={() => handleToggleEnabled(mirror.url)}
                      aria-label={`Enable mirror ${mirror.url}`}
                    />
                  </Td>
                  <Td dataLabel="URL">
                    <Flex alignItems={{ default: "alignItemsCenter" }} spaceItems={{ default: "spaceItemsSm" }}>
                      {mirror.testResult && (
                        <FlexItem>
                          {mirror.testResult.success ? (
                            <CheckCircleIcon color="var(--pf-t--global--icon--color--status--success--default)" />
                          ) : (
                            <TimesCircleIcon color="var(--pf-t--global--icon--color--status--danger--default)" />
                          )}
                        </FlexItem>
                      )}
                      <FlexItem>
                        <span style={{ fontFamily: "var(--pf-t--global--font--family--mono)", fontSize: "0.875rem" }}>
                          {mirror.url}
                        </span>
                        {mirror.comment && (
                          <div style={{ fontSize: "0.75rem", color: "var(--pf-t--global--text--color--subtle)" }}>
                            {mirror.comment}
                          </div>
                        )}
                      </FlexItem>
                    </Flex>
                  </Td>
                  <Td dataLabel="Country">
                    {mirror.status?.country || "-"}
                    {mirror.status?.country_code && (
                      <span style={{ marginLeft: "0.5rem", color: "var(--pf-t--global--text--color--subtle)" }}>
                        ({mirror.status.country_code})
                      </span>
                    )}
                  </Td>
                  <Td dataLabel="Latency">
                    {mirror.testResult?.latency_ms !== undefined && mirror.testResult?.latency_ms !== null
                      ? `${mirror.testResult.latency_ms}ms`
                      : "-"}
                  </Td>
                  <Td dataLabel="Score">
                    {mirror.status?.score !== undefined && mirror.status?.score !== null
                      ? mirror.status.score.toFixed(2)
                      : "-"}
                  </Td>
                  <Td dataLabel="Actions">
                    <Flex spaceItems={{ default: "spaceItemsXs" }}>
                      <FlexItem>
                        <Button
                          variant="plain"
                          aria-label="Move up"
                          onClick={() => handleMoveUp(actualIndex)}
                          isDisabled={actualIndex === 0}
                        >
                          <ArrowUpIcon />
                        </Button>
                      </FlexItem>
                      <FlexItem>
                        <Button
                          variant="plain"
                          aria-label="Move down"
                          onClick={() => handleMoveDown(actualIndex)}
                          isDisabled={actualIndex === mirrors.length - 1}
                        >
                          <ArrowDownIcon />
                        </Button>
                      </FlexItem>
                    </Flex>
                  </Td>
                </Tr>
              );
            })}
          </Tbody>
        </Table>

        <ExpandableSection
          toggleText={backupsExpanded ? "Hide backup history" : "Backup history"}
          onToggle={handleBackupsToggle}
          isExpanded={backupsExpanded}
          className="pf-v6-u-mt-lg"
        >
          {backupsLoading ? (
            <Flex alignItems={{ default: "alignItemsCenter" }} spaceItems={{ default: "spaceItemsSm" }} className="pf-v6-u-py-md">
              <FlexItem><Spinner size="md" /></FlexItem>
              <FlexItem>Loading backups...</FlexItem>
            </Flex>
          ) : backups.length === 0 ? (
            <Content component={ContentVariants.p} className="pf-v6-u-py-md" style={{ color: "var(--pf-t--global--text--color--subtle)" }}>
              No backups found. Backups are created automatically when saving the mirrorlist.
            </Content>
          ) : (
            <>
            <Flex className="pf-v6-u-mb-sm" spaceItems={{ default: "spaceItemsSm" }}>
              <FlexItem>
                <Button
                  variant="danger"
                  size="sm"
                  icon={<TrashIcon />}
                  onClick={handleDeleteSelected}
                  isDisabled={selectedBackups.size === 0 || deletingBackups || restoringTimestamp !== null}
                  isLoading={deletingBackups}
                >
                  Delete {selectedBackups.size > 0 ? `(${selectedBackups.size})` : "selected"}
                </Button>
              </FlexItem>
            </Flex>
            <Table aria-label="Mirrorlist backups" variant="compact">
              <Thead>
                <Tr>
                  <Th screenReaderText="Select">
                    <Checkbox
                      id="select-all-backups"
                      isChecked={allBackupsSelected ? true : someBackupsSelected ? null : false}
                      onChange={(_event, checked) => checked ? selectAllBackups() : deselectAllBackups()}
                      aria-label="Select all backups"
                    />
                  </Th>
                  <Th>Date</Th>
                  <Th>Mirrors</Th>
                  <Th>Size</Th>
                  <Th width={10}>Actions</Th>
                </Tr>
              </Thead>
              <Tbody>
                {backups.map((backup) => (
                  <Tr key={backup.timestamp}>
                    <Td
                      select={{
                        rowIndex: backup.timestamp,
                        onSelect: () => toggleBackupSelection(backup.timestamp),
                        isSelected: selectedBackups.has(backup.timestamp),
                      }}
                    />
                    <Td dataLabel="Date">
                      <Flex alignItems={{ default: "alignItemsCenter" }} spaceItems={{ default: "spaceItemsSm" }}>
                        <FlexItem><HistoryIcon /></FlexItem>
                        <FlexItem>{backup.date}</FlexItem>
                      </Flex>
                    </Td>
                    <Td dataLabel="Mirrors">
                      {backup.enabled_count} enabled / {backup.total_count} total
                    </Td>
                    <Td dataLabel="Size">{formatSize(backup.size)}</Td>
                    <Td dataLabel="Actions">
                      <Button
                        variant="secondary"
                        size="sm"
                        icon={<UndoIcon />}
                        onClick={() => setRestoreConfirmTimestamp(backup.timestamp)}
                        isDisabled={restoringTimestamp !== null || deletingBackups}
                        isLoading={restoringTimestamp === backup.timestamp}
                      >
                        Restore
                      </Button>
                    </Td>
                  </Tr>
                ))}
              </Tbody>
            </Table>
            </>
          )}
        </ExpandableSection>

        {statusData && (
          <div className="pf-v6-u-mt-md" style={{ fontSize: "0.75rem", color: "var(--pf-t--global--text--color--subtle)" }}>
            Mirror status from archlinux.org: {statusData.last_check || "Unknown"}
            {getCacheAge() !== null && ` (cached ${formatCacheAge(getCacheAge()!)})`}
          </div>
        )}
      </CardBody>

      <Modal
        variant={ModalVariant.small}
        isOpen={confirmModalOpen}
        onClose={() => setConfirmModalOpen(false)}
      >
        <ModalHeader title="Save mirrorlist?" />
        <ModalBody>
          <Content>
            <Content component={ContentVariants.p}>
              This will overwrite <code>/etc/pacman.d/mirrorlist</code> with your changes.
              A backup will be created before saving.
            </Content>
            <Content component={ContentVariants.p} className="pf-v6-u-mt-md">
              <strong>{mirrors.filter(m => m.enabled).length}</strong> mirrors will be enabled.
            </Content>
          </Content>
        </ModalBody>
        <ModalFooter>
          <Button key="confirm" variant="primary" onClick={startSave}>
            Save Mirrorlist
          </Button>
          <Button key="cancel" variant="link" onClick={() => setConfirmModalOpen(false)}>
            Cancel
          </Button>
        </ModalFooter>
      </Modal>

      <Modal
        variant={ModalVariant.large}
        isOpen={refreshModalOpen}
        onClose={() => { if (!refreshLoading) setRefreshModalOpen(false); }}
      >
        <ModalHeader title="Refresh Mirrorlist" />
        <ModalBody>
          <Content component={ContentVariants.p} className="pf-v6-u-mb-md">
            Generate a ranked mirrorlist from the Arch Linux mirror status API.
            Filters to active, synced mirrors sorted by quality.
            Applying the result will replace your current mirrorlist.
          </Content>
          <Form isHorizontal>
            <FormGroup label="Number of mirrors" fieldId="refresh-count">
              <NumberInput
                id="refresh-count"
                value={refreshCount}
                onMinus={() => setRefreshCount(Math.max(1, refreshCount - 5))}
                onPlus={() => setRefreshCount(Math.min(100, refreshCount + 5))}
                onChange={(event) => {
                  const value = parseInt((event.target as HTMLInputElement).value, 10);
                  if (!isNaN(value) && value >= 1 && value <= 100) setRefreshCount(value);
                }}
                min={1}
                max={100}
              />
            </FormGroup>
            <FormGroup label="Country" fieldId="refresh-country">
              <FormSelect
                id="refresh-country"
                value={refreshCountry}
                onChange={(_event, value) => setRefreshCountry(value)}
              >
                <FormSelectOption value="" label="All countries" />
                {statusCountries.map(([code, name]) => (
                  <FormSelectOption key={code} value={code} label={`${name} (${code})`} />
                ))}
              </FormSelect>
            </FormGroup>
            <FormGroup label="Protocol" fieldId="refresh-protocol">
              <FormSelect
                id="refresh-protocol"
                value={refreshProtocol}
                onChange={(_event, value) => setRefreshProtocol(value as RefreshMirrorsProtocol)}
              >
                <FormSelectOption value="https" label="HTTPS only" />
                <FormSelectOption value="http" label="HTTP only" />
                <FormSelectOption value="all" label="All protocols" />
              </FormSelect>
            </FormGroup>
            <FormGroup label="Sort by" fieldId="refresh-sort">
              <FormSelect
                id="refresh-sort"
                value={refreshSortBy}
                onChange={(_event, value) => setRefreshSortBy(value as RefreshMirrorsSortBy)}
              >
                <FormSelectOption value="score" label="Mirror score (lower = better)" />
                <FormSelectOption value="delay" label="Sync delay (lower = better)" />
                <FormSelectOption value="age" label="Last sync time (newest first)" />
              </FormSelect>
            </FormGroup>
          </Form>

          <div className="pf-v6-u-mt-lg">
            <Button
              variant="secondary"
              onClick={handleRefreshGenerate}
              isLoading={refreshLoading}
              isDisabled={refreshLoading}
            >
              {refreshLoading ? "Fetching..." : "Generate Preview"}
            </Button>
          </div>

          {refreshError && (
            <Alert variant="danger" isInline isPlain title={refreshError} className="pf-v6-u-mt-md" />
          )}

          {refreshPreview && (
            <div className="pf-v6-u-mt-lg">
              <Content component={ContentVariants.p}>
                <strong>{refreshPreview.total}</strong> mirrors found
                {refreshPreview.last_check && ` (status checked: ${refreshPreview.last_check})`}
              </Content>
              <div style={{ maxHeight: "300px", overflow: "auto" }} className="pf-v6-u-mt-sm">
                <Table aria-label="Preview mirrors" variant="compact">
                  <Thead>
                    <Tr>
                      <Th width={10}>#</Th>
                      <Th>URL</Th>
                      <Th width={20}>Country</Th>
                    </Tr>
                  </Thead>
                  <Tbody>
                    {refreshPreview.mirrors.map((m, i) => (
                      <Tr key={m.url}>
                        <Td dataLabel="#">{i + 1}</Td>
                        <Td dataLabel="URL">
                          <span style={{ fontFamily: "var(--pf-t--global--font--family--mono)", fontSize: "0.875rem" }}>
                            {m.url}
                          </span>
                        </Td>
                        <Td dataLabel="Country">{m.comment || "-"}</Td>
                      </Tr>
                    ))}
                  </Tbody>
                </Table>
              </div>
            </div>
          )}
        </ModalBody>
        <ModalFooter>
          <Button
            key="apply"
            variant="primary"
            onClick={handleRefreshApply}
            isDisabled={!refreshPreview || refreshLoading}
          >
            Apply
          </Button>
          <Button
            key="cancel"
            variant="link"
            onClick={() => setRefreshModalOpen(false)}
            isDisabled={refreshLoading}
          >
            Cancel
          </Button>
        </ModalFooter>
      </Modal>

      <Modal
        variant={ModalVariant.small}
        isOpen={restoreConfirmTimestamp !== null}
        onClose={() => setRestoreConfirmTimestamp(null)}
      >
        <ModalHeader title="Restore mirrorlist backup?" />
        <ModalBody>
          <Content>
            <Content component={ContentVariants.p}>
              This will replace the current <code>/etc/pacman.d/mirrorlist</code> with the selected backup.
              A backup of the current state will be created first.
            </Content>
            {restoreConfirmTimestamp !== null && (() => {
              const b = backups.find(x => x.timestamp === restoreConfirmTimestamp);
              return b ? (
                <Content component={ContentVariants.p} className="pf-v6-u-mt-md">
                  Backup from <strong>{b.date}</strong> with {b.enabled_count} enabled mirrors.
                </Content>
              ) : null;
            })()}
          </Content>
        </ModalBody>
        <ModalFooter>
          <Button key="confirm" variant="primary" onClick={() => restoreConfirmTimestamp !== null && handleRestore(restoreConfirmTimestamp)}>
            Restore
          </Button>
          <Button key="cancel" variant="link" onClick={() => setRestoreConfirmTimestamp(null)}>
            Cancel
          </Button>
        </ModalFooter>
      </Modal>
    </Card>
  );
};
