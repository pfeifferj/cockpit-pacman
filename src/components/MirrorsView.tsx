import React, { useState, useEffect, useCallback, useRef, useMemo } from "react";
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
  TextInput,
  Switch,
  MenuToggle,
  Select,
  SelectOption,
  SelectList,
} from "@patternfly/react-core";
import {
  GlobeIcon,
  CheckCircleIcon,
  TimesCircleIcon,
  ArrowUpIcon,
  ArrowDownIcon,
  SyncAltIcon,
  OutlinedClockIcon,
} from "@patternfly/react-icons";
import { Table, Thead, Tr, Th, Tbody, Td, ThProps } from "@patternfly/react-table";
import {
  MirrorEntry,
  MirrorListResponse,
  MirrorStatus,
  MirrorStatusResponse,
  MirrorTestResult,
  listMirrors,
  fetchMirrorStatus,
  testMirrors,
  saveMirrorlist,
  formatNumber,
  formatDate,
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
  const [hasChanges, setHasChanges] = useState(false);
  const [searchFilter, setSearchFilter] = useState("");
  const [countryFilter, setCountryFilter] = useState<string>("all");
  const [countryFilterOpen, setCountryFilterOpen] = useState(false);
  const [activeSortIndex, setActiveSortIndex] = useState<number | null>(null);
  const [activeSortDirection, setActiveSortDirection] = useState<"asc" | "desc">("asc");
  const cancelRef = useRef<(() => void) | null>(null);
  const logContainerRef = useRef<HTMLDivElement | null>(null);

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

  const countries = useMemo(() => {
    const countrySet = new Set<string>();
    for (const m of mirrors) {
      if (m.status?.country) {
        countrySet.add(m.status.country);
      }
    }
    return Array.from(countrySet).sort();
  }, [mirrors]);

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
          <Alert variant="danger" title="Error loading mirrors">
            {sanitizeErrorMessage(error)}
          </Alert>
          <div className="pf-v6-u-mt-md">
            <Button variant="primary" onClick={loadMirrors}>
              Retry
            </Button>
          </div>
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
                <div style={{ textAlign: "center", padding: "0.75rem 1.5rem", background: "var(--pf-t--global--background--color--secondary--default)", borderRadius: "6px" }}>
                  <div style={{ fontSize: "1.5rem", fontWeight: 600 }}>{formatNumber(mirrors.length)}</div>
                  <div style={{ fontSize: "0.75rem", color: "var(--pf-t--global--text--color--subtle)", textTransform: "uppercase" }}>Total</div>
                </div>
              </FlexItem>
              <FlexItem>
                <div style={{ textAlign: "center", padding: "0.75rem 1.5rem", background: "var(--pf-t--global--background--color--secondary--default)", borderRadius: "6px" }}>
                  <div style={{ fontSize: "1.5rem", fontWeight: 600, color: "var(--pf-t--global--color--status--success--default)" }}>{formatNumber(mirrors.filter(m => m.enabled).length)}</div>
                  <div style={{ fontSize: "0.75rem", color: "var(--pf-t--global--text--color--subtle)", textTransform: "uppercase" }}>Enabled</div>
                </div>
              </FlexItem>
              {mirrorData?.last_modified && (
                <FlexItem>
                  <div style={{ textAlign: "center", padding: "0.75rem 1.5rem", background: "var(--pf-t--global--background--color--secondary--default)", borderRadius: "6px" }}>
                    <div style={{ fontSize: "1rem", fontWeight: 600 }}>{formatDate(mirrorData.last_modified)}</div>
                    <div style={{ fontSize: "0.75rem", color: "var(--pf-t--global--text--color--subtle)", textTransform: "uppercase" }}>Last Modified</div>
                  </div>
                </FlexItem>
              )}
            </Flex>
          </FlexItem>
          <FlexItem>
            <Flex spaceItems={{ default: "spaceItemsSm" }}>
              <FlexItem>
                <Button
                  variant="secondary"
                  icon={<SyncAltIcon />}
                  onClick={() => handleFetchStatus(true)}
                  isDisabled={state !== "ready"}
                >
                  {statusData ? "Refresh Status" : "Fetch Status"}
                </Button>
              </FlexItem>
              <FlexItem>
                <Button
                  variant="secondary"
                  icon={<OutlinedClockIcon />}
                  onClick={handleTestMirrors}
                  isDisabled={state !== "ready" || mirrors.filter(m => m.enabled).length === 0}
                >
                  Test Mirrors
                </Button>
              </FlexItem>
              <FlexItem>
                <Button
                  variant="primary"
                  onClick={handleSave}
                  isDisabled={!hasChanges || state !== "ready"}
                >
                  Save Changes
                </Button>
              </FlexItem>
            </Flex>
          </FlexItem>
        </Flex>

        <Flex spaceItems={{ default: "spaceItemsMd" }} className="pf-v6-u-mb-md">
          <FlexItem>
            <TextInput
              type="search"
              aria-label="Search mirrors"
              placeholder="Search mirrors..."
              value={searchFilter}
              onChange={(_event, value) => setSearchFilter(value)}
              style={{ minWidth: "250px" }}
            />
          </FlexItem>
          {countries.length > 0 && (
            <FlexItem>
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
            </FlexItem>
          )}
        </Flex>

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
    </Card>
  );
};
