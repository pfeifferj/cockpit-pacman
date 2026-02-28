import React, { useState, useEffect, useCallback, useRef, useMemo } from "react";
import { useAutoScrollLog } from "../hooks/useAutoScrollLog";
import { usePackageDetails } from "../hooks/usePackageDetails";
import { useSortableTable } from "../hooks/useSortableTable";
import {
  Button,
  Spinner,
  Alert,
  Modal,
  ModalVariant,
  ModalHeader,
  ModalBody,
  ModalFooter,
  Content,
  ContentVariants,
  EmptyState,
  EmptyStateBody,
  EmptyStateActions,
  EmptyStateFooter,
  CodeBlock,
  CodeBlockCode,
  ExpandableSection,
  Flex,
  FlexItem,
  Label,
  SearchInput,
} from "@patternfly/react-core";
import { TrashIcon, CheckCircleIcon } from "@patternfly/react-icons";
import { StatBox } from "./StatBox";
import { PackageDetailsModal } from "./PackageDetailsModal";
import { Table, Thead, Tr, Th, Tbody, Td } from "@patternfly/react-table";
import {
  OrphanPackage,
  OrphanResponse,
  listOrphans,
  removeOrphans,
  formatSize,
  formatDate,
} from "../api";
import { LOG_CONTAINER_HEIGHT, MAX_LOG_SIZE_BYTES } from "../constants";

type ViewState = "loading" | "ready" | "removing" | "success";

export const OrphansView: React.FC = () => {
  const [orphanData, setOrphanData] = useState<OrphanResponse | null>(null);
  const [viewState, setViewState] = useState<ViewState>("loading");
  const [error, setError] = useState<string | null>(null);
  const [searchValue, setSearchValue] = useState("");
  const [confirmModalOpen, setConfirmModalOpen] = useState(false);
  const [log, setLog] = useState("");
  const [logExpanded, setLogExpanded] = useState(false);
  const cancelRef = useRef<(() => void) | null>(null);
  const isMountedRef = useRef(true);
  const logContainerRef = useAutoScrollLog(log);

  const { selectedPackage, detailsLoading, detailsError, fetchDetails, clearDetails } = usePackageDetails();

  const { activeSortIndex, activeSortDirection, getSortParams } = useSortableTable({
    sortableColumns: [0, 2, 3],
    defaultDirection: "asc",
  });

  useEffect(() => {
    isMountedRef.current = true;
    return () => {
      isMountedRef.current = false;
    };
  }, []);

  useEffect(() => {
    return () => {
      if (cancelRef.current) {
        cancelRef.current();
      }
    };
  }, []);

  const loadOrphans = useCallback(async () => {
    setViewState("loading");
    setError(null);
    try {
      const response = await listOrphans();
      if (!isMountedRef.current) return;
      setOrphanData(response);
      setViewState("ready");
    } catch (ex) {
      if (!isMountedRef.current) return;
      setError(ex instanceof Error ? ex.message : String(ex));
      setViewState("ready");
    }
  }, []);

  useEffect(() => {
    loadOrphans();
  }, [loadOrphans]);

  const handleRowClick = (pkgName: string) => {
    fetchDetails(pkgName);
  };

  const startRemoval = () => {
    setConfirmModalOpen(false);
    setViewState("removing");
    setLog("");
    setLogExpanded(true);

    const { cancel } = removeOrphans({
      onData: (data) => setLog((prev) => {
        const newLog = prev + data;
        return newLog.length > MAX_LOG_SIZE_BYTES ? newLog.slice(-MAX_LOG_SIZE_BYTES) : newLog;
      }),
      onComplete: () => {
        setViewState("success");
        setOrphanData(null);
        cancelRef.current = null;
      },
      onError: (err) => {
        setViewState("ready");
        setError(err);
        cancelRef.current = null;
      },
    });
    cancelRef.current = cancel;
  };

  const handleCancel = () => {
    if (cancelRef.current) {
      cancelRef.current();
      cancelRef.current = null;
      setViewState("ready");
      setLog("");
    }
  };

  const handleSuccessRefresh = () => {
    setViewState("loading");
    setLog("");
    loadOrphans();
  };

  const filteredAndSorted = useMemo(() => {
    if (!orphanData?.orphans) return [];
    const searchLower = searchValue.toLowerCase();
    const filtered = searchValue
      ? orphanData.orphans.filter(pkg =>
          pkg.name.toLowerCase().includes(searchLower) ||
          (pkg.description?.toLowerCase().includes(searchLower) ?? false)
        )
      : orphanData.orphans;
    return [...filtered].sort((a, b) => {
      if (activeSortIndex === null) return 0;
      let comparison = 0;
      switch (activeSortIndex) {
        case 0:
          comparison = a.name.localeCompare(b.name);
          break;
        case 2:
          comparison = a.installed_size - b.installed_size;
          break;
        case 3:
          comparison = (a.install_date ?? 0) - (b.install_date ?? 0);
          break;
        default:
          return 0;
      }
      return activeSortDirection === "asc" ? comparison : -comparison;
    });
  }, [orphanData, activeSortIndex, activeSortDirection, searchValue]);

  if (viewState === "loading") {
    return (
      <div className="pf-v6-u-p-xl pf-v6-u-text-align-center">
        <Spinner /> Checking for orphan packages...
      </div>
    );
  }

  if (error) {
    const isLockError = error.toLowerCase().includes("unable to lock database");
    return (
      <>
        <Alert
          variant={isLockError ? "warning" : "danger"}
          title={isLockError ? "Database is locked" : "Error loading orphans"}
        >
          {isLockError
            ? "Another package manager operation is in progress. Please wait for it to complete."
            : error}
        </Alert>
      </>
    );
  }

  if (viewState === "removing") {
    return (
      <>
        <Flex justifyContent={{ default: "justifyContentSpaceBetween" }} alignItems={{ default: "alignItemsCenter" }} className="pf-v6-u-mb-md">
          <FlexItem>
            <strong>Removing Orphan Packages</strong>
          </FlexItem>
          <FlexItem>
            <Button variant="danger" onClick={handleCancel}>
              Cancel
            </Button>
          </FlexItem>
        </Flex>

        <div className="pf-v6-u-mb-md">
          <Spinner size="md" /> Removing packages...
        </div>

        <ExpandableSection
          toggleText={logExpanded ? "Hide details" : "Show details"}
          onToggle={(_event, expanded) => setLogExpanded(expanded)}
          isExpanded={logExpanded}
        >
          <div ref={logContainerRef} style={{ maxHeight: LOG_CONTAINER_HEIGHT, overflow: "auto" }}>
            <CodeBlock>
              <CodeBlockCode>{log || "Starting..."}</CodeBlockCode>
            </CodeBlock>
          </div>
        </ExpandableSection>
      </>
    );
  }

  if (viewState === "success") {
    return (
      <>
        <EmptyState headingLevel="h2" icon={CheckCircleIcon} titleText="Orphan packages removed">
          <EmptyStateBody>
            All orphan packages have been successfully removed.
          </EmptyStateBody>
          <EmptyStateFooter>
            <EmptyStateActions>
              <Button variant="primary" onClick={handleSuccessRefresh}>
                Check Again
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
      </>
    );
  }

  if (!orphanData?.orphans.length) {
    return (
      <EmptyState headingLevel="h2" icon={CheckCircleIcon} titleText="No orphan packages">
        <EmptyStateBody>
          Your system has no orphan packages. Orphans are packages that were installed as dependencies but are no longer required by any other package.
        </EmptyStateBody>
        <EmptyStateFooter>
          <EmptyStateActions>
            <Button variant="secondary" onClick={loadOrphans}>
              Refresh
            </Button>
          </EmptyStateActions>
        </EmptyStateFooter>
      </EmptyState>
    );
  }

  return (
    <>
      <Flex justifyContent={{ default: "justifyContentSpaceBetween" }} alignItems={{ default: "alignItemsFlexStart" }} className="pf-v6-u-mb-md">
        <FlexItem>
          <Flex spaceItems={{ default: "spaceItemsLg" }}>
            <FlexItem>
              <StatBox
                label="Space to Free"
                value={formatSize(orphanData.total_size)}
                color="success"
              />
            </FlexItem>
          </Flex>
        </FlexItem>
        <FlexItem>
          <Flex spaceItems={{ default: "spaceItemsMd" }} alignItems={{ default: "alignItemsCenter" }}>
            <FlexItem>
              <SearchInput
                placeholder="Filter orphans..."
                value={searchValue}
                onChange={(_event, value) => setSearchValue(value)}
                onClear={() => setSearchValue("")}
              />
            </FlexItem>
            <FlexItem>
              <Button
                variant="danger"
                icon={<TrashIcon />}
                onClick={() => setConfirmModalOpen(true)}
              >
                Remove All Orphans
              </Button>
            </FlexItem>
          </Flex>
        </FlexItem>
      </Flex>

      <Table aria-label="Orphan packages" variant="compact">
        <Thead>
          <Tr>
            <Th sort={getSortParams(0)}>Package</Th>
            <Th>Version</Th>
            <Th sort={getSortParams(2)}>Size</Th>
            <Th sort={getSortParams(3)}>Installed</Th>
            <Th>Repository</Th>
          </Tr>
        </Thead>
        <Tbody>
          {filteredAndSorted.map((pkg: OrphanPackage) => (
            <Tr key={pkg.name} isClickable onRowClick={() => handleRowClick(pkg.name)}>
              <Td dataLabel="Package">
                <Button variant="link" isInline className="pf-v6-u-p-0">
                  {pkg.name}
                </Button>
              </Td>
              <Td dataLabel="Version">{pkg.version}</Td>
              <Td dataLabel="Size">{formatSize(pkg.installed_size)}</Td>
              <Td dataLabel="Installed">{formatDate(pkg.install_date)}</Td>
              <Td dataLabel="Repository">
                <Label color={pkg.repository ? "blue" : "grey"}>
                  {pkg.repository || "user"}
                </Label>
              </Td>
            </Tr>
          ))}
        </Tbody>
      </Table>

      <PackageDetailsModal
        packageDetails={selectedPackage}
        isLoading={detailsLoading}
        onClose={clearDetails}
        error={detailsError}
      />

      <Modal
        variant={ModalVariant.small}
        isOpen={confirmModalOpen}
        onClose={() => setConfirmModalOpen(false)}
      >
        <ModalHeader title="Remove orphan packages?" />
        <ModalBody>
          <Content>
            <Content component={ContentVariants.p}>
              This will remove <strong>{orphanData.orphans.length}</strong> package{orphanData.orphans.length !== 1 ? "s" : ""} ({formatSize(orphanData.total_size)}).
            </Content>
            <Content component={ContentVariants.p}>
              Orphan packages are dependencies that are no longer required by any explicitly installed package.
            </Content>
          </Content>
        </ModalBody>
        <ModalFooter>
          <Button key="confirm" variant="danger" onClick={startRemoval}>
            Remove All
          </Button>
          <Button key="cancel" variant="link" onClick={() => setConfirmModalOpen(false)}>
            Cancel
          </Button>
        </ModalFooter>
      </Modal>
    </>
  );
};
