import React, { useState, useEffect, useCallback, useRef } from "react";
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
  Slider,
  ClipboardCopy,
  ClipboardCopyVariant,
} from "@patternfly/react-core";
import { TrashIcon, CheckCircleIcon, FolderIcon } from "@patternfly/react-icons";
import { PackageDetailsModal } from "./PackageDetailsModal";
import { StatBox } from "./StatBox";
import { Table, Thead, Tr, Th, Tbody, Td, ThProps } from "@patternfly/react-table";
import {
  CacheInfo,
  CachePackage,
  PackageDetails,
  SyncPackageDetails,
  getCacheInfo,
  cleanCache,
  getPackageInfo,
  getSyncPackageInfo,
  formatSize,
  formatNumber,
} from "../api";
import { sanitizeErrorMessage } from "../utils";

type ViewState = "loading" | "ready" | "cleaning" | "success" | "error";

export const CacheView: React.FC = () => {
  const [state, setState] = useState<ViewState>("loading");
  const [cacheData, setCacheData] = useState<CacheInfo | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [log, setLog] = useState("");
  const [isDetailsExpanded, setIsDetailsExpanded] = useState(false);
  const [confirmModalOpen, setConfirmModalOpen] = useState(false);
  const [keepVersions, setKeepVersions] = useState(3);
  const [activeSortIndex, setActiveSortIndex] = useState<number | null>(null);
  const [activeSortDirection, setActiveSortDirection] = useState<"asc" | "desc">("asc");
  const [selectedPackage, setSelectedPackage] = useState<PackageDetails | SyncPackageDetails | null>(null);
  const [detailsLoading, setDetailsLoading] = useState(false);
  const [detailsError, setDetailsError] = useState<string | null>(null);
  const cancelRef = useRef<(() => void) | null>(null);
  const logContainerRef = useRef<HTMLDivElement | null>(null);
  const isMountedRef = useRef(true);

  const loadCacheInfo = useCallback(async () => {
    setState("loading");
    setError(null);
    try {
      const response = await getCacheInfo();
      setCacheData(response);
      setState("ready");
    } catch (ex) {
      setState("error");
      setError(ex instanceof Error ? ex.message : String(ex));
    }
  }, []);

  useEffect(() => {
    loadCacheInfo();
  }, [loadCacheInfo]);

  useEffect(() => {
    return () => {
      isMountedRef.current = false;
      if (cancelRef.current) {
        cancelRef.current();
      }
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

  useEffect(() => {
    if (logContainerRef.current) {
      logContainerRef.current.scrollTop = logContainerRef.current.scrollHeight;
    }
  }, [log]);

  const handleCleanCache = () => {
    setConfirmModalOpen(true);
  };

  const startCleanup = () => {
    setConfirmModalOpen(false);
    setState("cleaning");
    setLog("");
    setIsDetailsExpanded(true);

    const { cancel } = cleanCache(
      {
        onData: (data) => setLog((prev) => {
          const newLog = prev + data;
          return newLog.length > MAX_LOG_SIZE_BYTES ? newLog.slice(-MAX_LOG_SIZE_BYTES) : newLog;
        }),
        onComplete: () => {
          setState("success");
          cancelRef.current = null;
        },
        onError: (err) => {
          setState("error");
          setError(err);
          cancelRef.current = null;
        },
      },
      keepVersions
    );
    cancelRef.current = cancel;
  };

  const handleCancel = () => {
    if (cancelRef.current) {
      cancelRef.current();
      cancelRef.current = null;
      setState("ready");
      setLog("");
    }
  };

  const sortableColumns = [0, 1, 2];

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

  const groupedPackages = React.useMemo(() => {
    if (!cacheData?.packages) return new Map<string, CachePackage[]>();
    const groups = new Map<string, CachePackage[]>();
    for (const pkg of cacheData.packages) {
      const existing = groups.get(pkg.name) || [];
      existing.push(pkg);
      groups.set(pkg.name, existing);
    }
    return groups;
  }, [cacheData]);

  const sortedPackages = React.useMemo(() => {
    if (!cacheData?.packages) return [];
    return [...cacheData.packages].sort((a, b) => {
      if (activeSortIndex === null) return 0;
      let comparison = 0;
      switch (activeSortIndex) {
        case 0:
          comparison = a.name.localeCompare(b.name);
          break;
        case 1:
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
  }, [cacheData, activeSortIndex, activeSortDirection]);

  const uniquePackageCount = groupedPackages.size;
  const multiVersionPackages = Array.from(groupedPackages.values()).filter(
    (versions) => versions.length > 1
  ).length;

  if (state === "loading") {
    return (
      <Card>
        <CardBody>
          <EmptyState headingLevel="h2" icon={Spinner} titleText="Loading cache information">
            <EmptyStateBody>Scanning package cache...</EmptyStateBody>
          </EmptyState>
        </CardBody>
      </Card>
    );
  }

  if (state === "error") {
    return (
      <Card>
        <CardBody>
          <Alert variant="danger" title="Error loading cache information">
            {sanitizeErrorMessage(error)}
          </Alert>
          <div className="pf-v6-u-mt-md">
            <Button variant="primary" onClick={loadCacheInfo}>
              Retry
            </Button>
          </div>
        </CardBody>
      </Card>
    );
  }

  if (state === "cleaning") {
    return (
      <Card>
        <CardBody>
          <Flex justifyContent={{ default: "justifyContentSpaceBetween" }} alignItems={{ default: "alignItemsCenter" }}>
            <FlexItem>
              <CardTitle className="pf-v6-u-m-0">Cleaning Package Cache</CardTitle>
            </FlexItem>
            <FlexItem>
              <Button variant="danger" onClick={handleCancel}>
                Cancel
              </Button>
            </FlexItem>
          </Flex>

          <div className="pf-v6-u-mt-md pf-v6-u-mb-md">
            <Spinner size="md" /> Cleaning cache (keeping {keepVersions} version{keepVersions !== 1 ? "s" : ""})...
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
        </CardBody>
      </Card>
    );
  }

  if (state === "success") {
    return (
      <Card>
        <CardBody>
          <EmptyState headingLevel="h2" icon={CheckCircleIcon} titleText="Cache cleaned">
            <EmptyStateBody>
              Old package versions have been removed from the cache.
            </EmptyStateBody>
            <EmptyStateFooter>
              <EmptyStateActions>
                <Button variant="primary" onClick={loadCacheInfo}>
                  View Cache
                </Button>
              </EmptyStateActions>
            </EmptyStateFooter>
          </EmptyState>
          {log && (
            <div className="pf-v6-u-mt-md" style={{ maxHeight: LOG_CONTAINER_HEIGHT, overflow: "auto" }}>
              <CodeBlock>
                <CodeBlockCode>{log}</CodeBlockCode>
              </CodeBlock>
            </div>
          )}
        </CardBody>
      </Card>
    );
  }

  if (!cacheData?.packages.length) {
    return (
      <Card>
        <CardBody>
          <EmptyState headingLevel="h2" icon={FolderIcon} titleText="Cache is empty">
            <EmptyStateBody>
              The package cache at {cacheData?.path || "/var/cache/pacman/pkg"} contains no packages.
            </EmptyStateBody>
            <EmptyStateFooter>
              <EmptyStateActions>
                <Button variant="secondary" onClick={loadCacheInfo}>
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
            <CardTitle className="pf-v6-u-m-0">Package Cache</CardTitle>
            <Flex spaceItems={{ default: "spaceItemsSm" }} alignItems={{ default: "alignItemsCenter" }} className="pf-v6-u-mb-md">
              <FlexItem>
                <FolderIcon color="var(--pf-t--global--icon--color--subtle)" />
              </FlexItem>
              <FlexItem>
                <ClipboardCopy
                  isReadOnly
                  hoverTip="Copy path"
                  clickTip="Copied"
                  variant={ClipboardCopyVariant.inline}
                >
                  {cacheData.path}
                </ClipboardCopy>
              </FlexItem>
            </Flex>
            <Flex spaceItems={{ default: "spaceItemsLg" }} className="pf-v6-u-mb-md">
              <FlexItem>
                <StatBox
                  label="Total Size"
                  value={formatSize(cacheData.total_size)}
                />
              </FlexItem>
              <FlexItem>
                <StatBox
                  label="Cached Files"
                  value={formatNumber(cacheData.package_count)}
                />
              </FlexItem>
              <FlexItem>
                <StatBox
                  label="Unique Packages"
                  value={formatNumber(uniquePackageCount)}
                />
              </FlexItem>
              <FlexItem>
                <StatBox
                  label="Multi-Version"
                  value={formatNumber(multiVersionPackages)}
                  color={multiVersionPackages > 0 ? "info" : "default"}
                />
              </FlexItem>
            </Flex>
          </FlexItem>
          <FlexItem>
            <Button
              variant="secondary"
              icon={<TrashIcon />}
              onClick={handleCleanCache}
            >
              Clean Cache
            </Button>
          </FlexItem>
        </Flex>

        <Table aria-label="Cached packages" variant="compact">
          <Thead>
            <Tr>
              <Th sort={getSortParams(0)}>Package</Th>
              <Th sort={getSortParams(1)}>Version</Th>
              <Th sort={getSortParams(2)}>Size</Th>
            </Tr>
          </Thead>
          <Tbody>
            {sortedPackages.map((pkg: CachePackage) => (
              <Tr key={pkg.filename} isClickable onRowClick={() => handleRowClick(pkg.name)}>
                <Td dataLabel="Package">
                  <Button variant="link" isInline className="pf-v6-u-p-0">
                    {pkg.name}
                  </Button>
                </Td>
                <Td dataLabel="Version">{pkg.version}</Td>
                <Td dataLabel="Size">{formatSize(pkg.size)}</Td>
              </Tr>
            ))}
          </Tbody>
        </Table>
      </CardBody>

      <Modal
        variant={ModalVariant.small}
        isOpen={confirmModalOpen}
        onClose={() => setConfirmModalOpen(false)}
      >
        <ModalHeader title="Clean package cache?" />
        <ModalBody>
          <Content>
            <Content component={ContentVariants.p}>
              This will remove old versions of cached packages, keeping only the most recent versions.
            </Content>
            <Content component={ContentVariants.p} className="pf-v6-u-mt-md pf-v6-u-mb-sm">
              <strong>Versions to keep:</strong>
            </Content>
            <Slider
              value={keepVersions}
              onChange={(_event, value) => setKeepVersions(value)}
              min={0}
              max={5}
              showTicks
              customSteps={[
                { value: 0, label: "0" },
                { value: 1, label: "1" },
                { value: 2, label: "2" },
                { value: 3, label: "3" },
                { value: 4, label: "4" },
                { value: 5, label: "5" },
              ]}
            />
            <Content component={ContentVariants.p} className="pf-v6-u-mt-md">
              {keepVersions === 0
                ? "All cached packages will be removed."
                : `The ${keepVersions} most recent version${keepVersions !== 1 ? "s" : ""} of each package will be kept.`}
            </Content>
          </Content>
        </ModalBody>
        <ModalFooter>
          <Button key="confirm" variant="primary" onClick={startCleanup}>
            Clean Cache
          </Button>
          <Button key="cancel" variant="link" onClick={() => setConfirmModalOpen(false)}>
            Cancel
          </Button>
        </ModalFooter>
      </Modal>

      <PackageDetailsModal
        packageDetails={selectedPackage}
        isLoading={detailsLoading}
        onClose={() => {
          setSelectedPackage(null);
          setDetailsError(null);
        }}
        error={detailsError}
      />
    </Card>
  );
};
