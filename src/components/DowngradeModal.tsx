import React, { useState, useEffect, useCallback, useRef } from "react";
import { useBackdropClose } from "../hooks/useBackdropClose";
import { useDebouncedValue } from "../hooks/useDebounce";
import { LOG_CONTAINER_HEIGHT, SEARCH_DEBOUNCE_MS } from "../constants";
import {
  Modal,
  ModalVariant,
  ModalHeader,
  ModalBody,
  ModalFooter,
  Button,
  Spinner,
  Alert,
  AlertActionLink,
  EmptyState,
  EmptyStateBody,
  Label,
  CodeBlock,
  CodeBlockCode,
  ExpandableSection,
  Content,
  ContentVariants,
  ToggleGroup,
  ToggleGroupItem,
  SearchInput,
} from "@patternfly/react-core";
import { Table, Thead, Tr, Th, Tbody, Td, ThProps } from "@patternfly/react-table";
import { ArrowDownIcon, ArrowUpIcon, DownloadIcon, CheckCircleIcon } from "@patternfly/react-icons";
import {
  CachedVersion,
  listDowngrades,
  downgradePackage,
  listArchiveVersions,
  downgradeFromArchive,
  formatSize,
  BackendError,
} from "../api";
import type { ErrorCode } from "../api";
import { isNetworkError } from "../offline";
import { NetworkErrorState } from "./NetworkErrorState";
import { sanitizeErrorMessage } from "../utils";

type ModalState = "loading" | "select" | "confirm" | "downgrading" | "success" | "error";
type DowngradeSource = "cache" | "archive";

interface DowngradeModalProps {
  packageName: string;
  currentVersion: string;
  isOpen: boolean;
  onClose: () => void;
}

export const DowngradeModal: React.FC<DowngradeModalProps> = ({
  packageName,
  currentVersion,
  isOpen,
  onClose,
}) => {
  useBackdropClose(isOpen, onClose);
  const [state, setState] = useState<ModalState>("loading");
  const [source, setSource] = useState<DowngradeSource>("cache");
  const [versions, setVersions] = useState<CachedVersion[]>([]);
  const [selectedVersion, setSelectedVersion] = useState<CachedVersion | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [errorCode, setErrorCode] = useState<ErrorCode | undefined>(undefined);
  const [log, setLog] = useState("");
  const [isDetailsExpanded, setIsDetailsExpanded] = useState(false);
  const [activeSortIndex, setActiveSortIndex] = useState<number | null>(null);
  const [activeSortDirection, setActiveSortDirection] = useState<"asc" | "desc">("desc");
  const [versionFilter, setVersionFilter] = useState("");
  const [serverResults, setServerResults] = useState<{ query: string; packages: CachedVersion[]; failed: boolean } | null>(null);
  const cancelRef = useRef<(() => void) | null>(null);
  const logContainerRef = useRef<HTMLDivElement | null>(null);
  const loadIdRef = useRef(0);

  const loadVersions = useCallback(async (src: DowngradeSource) => {
    if (!packageName) return;
    const loadId = ++loadIdRef.current;
    setState("loading");
    setError(null);
    setErrorCode(undefined);
    try {
      const response = src === "archive"
        ? await listArchiveVersions(packageName)
        : await listDowngrades(packageName);
      if (loadId !== loadIdRef.current) return;
      setVersions(response.packages);
      setState("select");
    } catch (ex) {
      if (loadId !== loadIdRef.current) return;
      setState("error");
      setError(ex instanceof Error ? ex.message : String(ex));
      setErrorCode(ex instanceof BackendError ? ex.code : undefined);
    }
  }, [packageName]);

  useEffect(() => {
    if (!isOpen) return;
    Promise.resolve().then(() => {
      setSource("cache");
      setSelectedVersion(null);
      setLog("");
      setVersionFilter("");
      setServerResults(null);
      void loadVersions("cache");
    });
  }, [isOpen, loadVersions]);

  const handleSourceChange = (src: DowngradeSource) => {
    if (src === source) return;
    setSource(src);
    setActiveSortIndex(null);
    setVersionFilter("");
    setServerResults(null);
    void loadVersions(src);
  };

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

  const handleSelectVersion = (version: CachedVersion) => {
    setSelectedVersion(version);
    setState("confirm");
  };

  const handleConfirmDowngrade = () => {
    if (!selectedVersion) return;
    setState("downgrading");
    setLog("");
    setIsDetailsExpanded(true);

    const callbacks = {
      onData: (data: string) => setLog((prev) => prev + data),
      onComplete: () => {
        setState("success");
        cancelRef.current = null;
      },
      onError: (err: string, code?: ErrorCode) => {
        setState("error");
        setError(err);
        setErrorCode(code);
        cancelRef.current = null;
      },
    };
    const { cancel } = source === "archive"
      ? downgradeFromArchive(callbacks, packageName, selectedVersion.filename)
      : downgradePackage(callbacks, packageName, selectedVersion.version);
    cancelRef.current = cancel;
  };

  const handleCancel = () => {
    if (cancelRef.current) {
      cancelRef.current();
      cancelRef.current = null;
    }
    setState("select");
    setLog("");
  };

  const handleClose = () => {
    if (cancelRef.current) {
      cancelRef.current();
      cancelRef.current = null;
    }
    onClose();
  };

  const getSortParams = (columnIndex: number): ThProps["sort"] | undefined => {
    if (columnIndex !== 0 && columnIndex !== 2) return undefined;
    return {
      sortBy: {
        index: activeSortIndex ?? undefined,
        direction: activeSortDirection,
        defaultDirection: "desc",
      },
      onSort: (_event, index, direction) => {
        setActiveSortIndex(index);
        setActiveSortDirection(direction);
      },
      columnIndex,
    };
  };

  const sortedVersions = React.useMemo(() => {
    return [...versions].sort((a, b) => {
      if (activeSortIndex === null) return 0;
      let comparison = 0;
      switch (activeSortIndex) {
        case 0:
          comparison = a.version.localeCompare(b.version);
          break;
        case 2:
          comparison = a.size - b.size;
          break;
        default:
          return 0;
      }
      return activeSortDirection === "asc" ? comparison : -comparison;
    });
  }, [versions, activeSortIndex, activeSortDirection]);

  const filteredVersions = React.useMemo(() => {
    const query = versionFilter.trim().toLowerCase();
    if (!query) return sortedVersions;
    return sortedVersions.filter((v) => v.version.toLowerCase().includes(query));
  }, [sortedVersions, versionFilter]);

  const debouncedFilter = useDebouncedValue(versionFilter, SEARCH_DEBOUNCE_MS);

  // When the archive filter matches nothing in the fetched page, escalate to a
  // backend search that filters the full archive history before the cap.
  useEffect(() => {
    const query = debouncedFilter.trim();
    if (source !== "archive" || query === "") return;
    if (serverResults?.query === query) return;
    const clientHasMatch = versions.some((v) =>
      v.version.toLowerCase().includes(query.toLowerCase())
    );
    if (clientHasMatch) return;
    let cancelled = false;
    listArchiveVersions(packageName, query)
      .then((resp) => {
        if (!cancelled) setServerResults({ query, packages: resp.packages, failed: false });
      })
      .catch(() => {
        if (!cancelled) setServerResults({ query, packages: [], failed: true });
      });
    return () => {
      cancelled = true;
    };
  }, [debouncedFilter, source, versions, packageName, serverResults]);

  const renderContent = () => {
    switch (state) {
      case "loading":
        return (
          <EmptyState headingLevel="h3" icon={Spinner} titleText="Loading versions">
            <EmptyStateBody>
              {source === "archive"
                ? "Fetching versions from archive.archlinux.org..."
                : "Scanning package cache..."}
            </EmptyStateBody>
          </EmptyState>
        );

      case "error":
        if (isNetworkError(null, errorCode)) {
          return (
            <NetworkErrorState
              resource={source === "archive" ? "archive versions" : "package versions"}
              onRetry={() => loadVersions(source)}
              headingLevel="h3"
            />
          );
        }
        return (
          <Alert variant="danger" title="Error">
            {sanitizeErrorMessage(error)}
          </Alert>
        );

      case "select": {
        const trimmedFilter = versionFilter.trim();
        const escalate =
          source === "archive" && trimmedFilter !== "" && filteredVersions.length === 0;
        const serverResolved =
          escalate && serverResults !== null && serverResults.query === trimmedFilter;
        const rows = escalate ? (serverResolved ? serverResults.packages : []) : filteredVersions;
        const searchingServer = escalate && !serverResolved;
        const serverFailed = serverResolved && serverResults.failed;
        return (
          <>
            <ToggleGroup aria-label="Version source" className="pf-v6-u-mb-md">
              <ToggleGroupItem
                text="Cache"
                isSelected={source === "cache"}
                onChange={() => handleSourceChange("cache")}
              />
              <ToggleGroupItem
                text="Archive"
                isSelected={source === "archive"}
                onChange={() => handleSourceChange("archive")}
              />
            </ToggleGroup>
            {versions.length === 0 ? (
              <EmptyState headingLevel="h3" titleText="No versions available">
                <EmptyStateBody>
                  {source === "archive"
                    ? `No archived versions of ${packageName} were found for this architecture.`
                    : `No other versions of ${packageName} were found in the package cache.`}
                </EmptyStateBody>
              </EmptyState>
            ) : (
              <>
            <Content component={ContentVariants.p} className="pf-v6-u-mb-md">
              Select a version to downgrade <strong>{packageName}</strong> from{" "}
              <Label isCompact variant="outline">{currentVersion}</Label>
            </Content>
            {source === "archive" && (
              <Content component={ContentVariants.small} className="pf-v6-u-mb-md">
                Versions are fetched from archive.archlinux.org (sizes are approximate);
                the package is downloaded and verified on install.
              </Content>
            )}
            <SearchInput
              placeholder="Filter by version"
              value={versionFilter}
              onChange={(_event, value) => setVersionFilter(value)}
              onClear={() => setVersionFilter("")}
              className="pf-v6-u-mb-md"
              aria-label="Filter versions"
            />
            {searchingServer ? (
              <EmptyState headingLevel="h4" icon={Spinner} titleText="Searching the archive">
                <EmptyStateBody>
                  Looking for <strong>{trimmedFilter}</strong> in the full archive history...
                </EmptyStateBody>
              </EmptyState>
            ) : serverFailed ? (
              <Alert
                variant="warning"
                title="Archive search failed"
                isInline
                actionLinks={
                  <AlertActionLink onClick={() => setServerResults(null)}>
                    Retry
                  </AlertActionLink>
                }
              >
                Could not reach archive.archlinux.org. Check your connection.
              </Alert>
            ) : rows.length === 0 ? (
              <EmptyState headingLevel="h4" titleText="No matching versions">
                <EmptyStateBody>
                  No versions match <strong>{versionFilter}</strong>.
                </EmptyStateBody>
              </EmptyState>
            ) : (
            <>
            {escalate && serverResolved && (
              <Content component={ContentVariants.small} className="pf-v6-u-mb-md">
                Showing archive search results for <strong>{trimmedFilter}</strong> from the full history.
              </Content>
            )}
            <Table aria-label="Available versions" variant="compact">
              <Thead>
                <Tr>
                  <Th sort={getSortParams(0)}>Version</Th>
                  <Th>Status</Th>
                  <Th sort={getSortParams(2)}>Size</Th>
                  <Th>Action</Th>
                </Tr>
              </Thead>
              <Tbody>
                {rows.map((v) => {
                  const isCurrent = v.installed_version !== null && v.version === v.installed_version;
                  const isNotInstalled = v.installed_version === null;
                  return (
                    <Tr key={v.filename}>
                      <Td dataLabel="Version">
                        <code>{v.version}</code>
                      </Td>
                      <Td dataLabel="Status">
                        {isCurrent ? (
                          <Label isCompact color="green">installed</Label>
                        ) : isNotInstalled ? (
                          <Label isCompact color="grey">cached</Label>
                        ) : v.is_older ? (
                          <Label isCompact color="orange">older</Label>
                        ) : (
                          <Label isCompact color="blue">newer</Label>
                        )}
                      </Td>
                      <Td dataLabel="Size">{v.size > 0 ? formatSize(v.size) : "-"}</Td>
                      <Td dataLabel="Action">
                        {!isCurrent && (
                          <Button
                            variant="secondary"
                            size="sm"
                            icon={isNotInstalled ? <DownloadIcon /> : v.is_older ? <ArrowDownIcon /> : <ArrowUpIcon />}
                            onClick={() => handleSelectVersion(v)}
                          >
                            {isNotInstalled ? "Install" : v.is_older ? "Downgrade" : "Upgrade"}
                          </Button>
                        )}
                      </Td>
                    </Tr>
                  );
                })}
              </Tbody>
            </Table>
            </>
            )}
              </>
            )}
          </>
        );
      }

      case "confirm": {
        const isDowngrade = selectedVersion?.is_older ?? true;
        const actionWord = isDowngrade ? "downgrade" : "upgrade";
        return (
          <Content>
            <Content component={ContentVariants.p}>
              Are you sure you want to {actionWord} <strong>{packageName}</strong>?
            </Content>
            <Content component={ContentVariants.p} className="pf-v6-u-mt-md">
              <Label isCompact variant="outline">{currentVersion}</Label>
              {" -> "}
              <Label isCompact color={isDowngrade ? "orange" : "blue"}>{selectedVersion?.version}</Label>
            </Content>
            <Alert variant="warning" title="Warning" className="pf-v6-u-mt-md">
              {isDowngrade
                ? "Downgrading packages may cause dependency issues or break functionality."
                : "Installing a different cached version may cause dependency issues."}
              {" "}Only proceed if you know what you are doing.
            </Alert>
          </Content>
        );
      }

      case "downgrading":
        return (
          <>
            <div className="pf-v6-u-mb-md">
              <Spinner size="md" /> {selectedVersion?.is_older ? "Downgrading" : "Upgrading"} {packageName} to {selectedVersion?.version}...
            </div>
            <ExpandableSection
              toggleText={isDetailsExpanded ? "Hide details" : "Show details"}
              onToggle={(_event, expanded) => setIsDetailsExpanded(expanded)}
              isExpanded={isDetailsExpanded}
            >
              <div ref={logContainerRef} style={{ maxHeight: LOG_CONTAINER_HEIGHT, overflow: "auto" }}>
                <CodeBlock>
                  <CodeBlockCode>{log || "Starting..."}</CodeBlockCode>
                </CodeBlock>
              </div>
            </ExpandableSection>
          </>
        );

      case "success": {
        const doneWord = selectedVersion?.is_older ? "downgraded" : "upgraded";
        return (
          <EmptyState headingLevel="h3" icon={CheckCircleIcon} titleText="Version change complete">
            <EmptyStateBody>
              {packageName} has been {doneWord} to {selectedVersion?.version}.
            </EmptyStateBody>
          </EmptyState>
        );
      }

      default:
        return null;
    }
  };

  const renderFooter = () => {
    switch (state) {
      case "select":
        return (
          <Button variant="link" onClick={handleClose}>
            Cancel
          </Button>
        );

      case "confirm":
        return (
          <>
            <Button variant="warning" onClick={handleConfirmDowngrade}>
              {selectedVersion?.is_older ? "Confirm Downgrade" : "Confirm Upgrade"}
            </Button>
            <Button variant="link" onClick={() => setState("select")}>
              Back
            </Button>
          </>
        );

      case "downgrading":
        return (
          <Button variant="danger" onClick={handleCancel}>
            Cancel
          </Button>
        );

      case "success":
        return (
          <Button variant="primary" onClick={handleClose}>
            Close
          </Button>
        );

      case "error":
        return (
          <>
            <Button variant="primary" onClick={() => loadVersions(source)}>
              Retry
            </Button>
            <Button variant="link" onClick={handleClose}>
              Close
            </Button>
          </>
        );

      default:
        return null;
    }
  };

  return (
    <Modal
      variant={ModalVariant.medium}
      isOpen={isOpen}
      onClose={handleClose}
    >
      <ModalHeader title={`Downgrade ${packageName}`} />
      <ModalBody>{renderContent()}</ModalBody>
      <ModalFooter>{renderFooter()}</ModalFooter>
    </Modal>
  );
};
