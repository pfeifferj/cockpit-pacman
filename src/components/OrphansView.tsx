import React, { useState, useEffect, useCallback, useRef } from "react";
import { LOG_CONTAINER_HEIGHT, MAX_LOG_SIZE_BYTES } from "../constants";
import { useSortableTable } from "../hooks/useSortableTable";
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
  Label,
  ExpandableSection,
  Modal,
  ModalVariant,
  ModalHeader,
  ModalBody,
  ModalFooter,
  Content,
  ContentVariants,
} from "@patternfly/react-core";
import { TrashIcon, CheckCircleIcon } from "@patternfly/react-icons";
import { Table, Thead, Tr, Th, Tbody, Td } from "@patternfly/react-table";
import {
  OrphanPackage,
  OrphanResponse,
  listOrphans,
  removeOrphans,
  formatSize,
  formatDate,
  formatNumber,
} from "../api";

type ViewState = "loading" | "ready" | "removing" | "success" | "error";

export const OrphansView: React.FC = () => {
  const [state, setState] = useState<ViewState>("loading");
  const [orphanData, setOrphanData] = useState<OrphanResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [log, setLog] = useState("");
  const [isDetailsExpanded, setIsDetailsExpanded] = useState(false);
  const [confirmModalOpen, setConfirmModalOpen] = useState(false);
  const cancelRef = useRef<(() => void) | null>(null);
  const logContainerRef = useRef<HTMLDivElement | null>(null);

  const { activeSortIndex, activeSortDirection, getSortParams } = useSortableTable({
    sortableColumns: [0, 2, 3],
    defaultDirection: "asc",
  });

  const loadOrphans = useCallback(async () => {
    setState("loading");
    setError(null);
    try {
      const response = await listOrphans();
      setOrphanData(response);
      setState("ready");
    } catch (ex) {
      setState("error");
      setError(ex instanceof Error ? ex.message : String(ex));
    }
  }, []);

  useEffect(() => {
    loadOrphans();
  }, [loadOrphans]);

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

  const handleRemoveOrphans = () => {
    setConfirmModalOpen(true);
  };

  const startRemoval = () => {
    setConfirmModalOpen(false);
    setState("removing");
    setLog("");
    setIsDetailsExpanded(true);

    const { cancel } = removeOrphans({
      onData: (data) => setLog((prev) => {
        const newLog = prev + data;
        return newLog.length > MAX_LOG_SIZE_BYTES ? newLog.slice(-MAX_LOG_SIZE_BYTES) : newLog;
      }),
      onComplete: () => {
        setState("success");
        setOrphanData(null);
        cancelRef.current = null;
      },
      onError: (err) => {
        setState("error");
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
      setState("ready");
      setLog("");
    }
  };

  const sortedOrphans = React.useMemo(() => {
    if (!orphanData?.orphans) return [];
    return [...orphanData.orphans].sort((a, b) => {
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
  }, [orphanData, activeSortIndex, activeSortDirection]);

  if (state === "loading") {
    return (
      <Card>
        <CardBody>
          <EmptyState headingLevel="h2" icon={Spinner} titleText="Checking for orphan packages">
            <EmptyStateBody>Scanning installed packages...</EmptyStateBody>
          </EmptyState>
        </CardBody>
      </Card>
    );
  }

  if (state === "error") {
    const isLockError = error?.toLowerCase().includes("unable to lock database");
    return (
      <Card>
        <CardBody>
          <Alert
            variant={isLockError ? "warning" : "danger"}
            title={isLockError ? "Database is locked" : "Error checking for orphan packages"}
          >
            {isLockError
              ? "Another package manager operation is in progress. Please wait for it to complete."
              : error}
          </Alert>
          <div className="pf-v6-u-mt-md">
            <Button variant="primary" onClick={loadOrphans}>
              Retry
            </Button>
          </div>
        </CardBody>
      </Card>
    );
  }

  if (state === "removing") {
    return (
      <Card>
        <CardBody>
          <Flex justifyContent={{ default: "justifyContentSpaceBetween" }} alignItems={{ default: "alignItemsCenter" }}>
            <FlexItem>
              <CardTitle className="pf-v6-u-m-0">Removing Orphan Packages</CardTitle>
            </FlexItem>
            <FlexItem>
              <Button variant="danger" onClick={handleCancel}>
                Cancel
              </Button>
            </FlexItem>
          </Flex>

          <div className="pf-v6-u-mt-md pf-v6-u-mb-md">
            <Spinner size="md" /> Removing packages...
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
          <EmptyState headingLevel="h2" icon={CheckCircleIcon} titleText="Orphan packages removed">
            <EmptyStateBody>
              All orphan packages have been successfully removed.
            </EmptyStateBody>
            <EmptyStateFooter>
              <EmptyStateActions>
                <Button variant="primary" onClick={loadOrphans}>
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
        </CardBody>
      </Card>
    );
  }

  if (!orphanData?.orphans.length) {
    return (
      <Card>
        <CardBody>
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
        </CardBody>
      </Card>
    );
  }

  return (
    <Card>
      <CardBody>
        <Flex justifyContent={{ default: "justifyContentSpaceBetween" }} alignItems={{ default: "alignItemsFlexStart" }}>
          <FlexItem>
            <CardTitle className="pf-v6-u-m-0 pf-v6-u-mb-md">
              {formatNumber(orphanData.orphans.length)} orphan package{orphanData.orphans.length !== 1 ? "s" : ""} found
            </CardTitle>
            <Flex spaceItems={{ default: "spaceItemsLg" }} className="pf-v6-u-mb-md">
              <FlexItem>
                <div style={{ textAlign: "center", padding: "0.75rem 1.5rem", background: "var(--pf-t--global--background--color--secondary--default)", borderRadius: "6px" }}>
                  <div style={{ fontSize: "1.5rem", fontWeight: 600, color: "var(--pf-t--global--color--status--success--default)" }}>{formatSize(orphanData.total_size)}</div>
                  <div style={{ fontSize: "0.75rem", color: "var(--pf-t--global--text--color--subtle)", textTransform: "uppercase" }}>Space to Free</div>
                </div>
              </FlexItem>
            </Flex>
          </FlexItem>
          <FlexItem>
            <Button
              variant="danger"
              icon={<TrashIcon />}
              onClick={handleRemoveOrphans}
            >
              Remove All Orphans
            </Button>
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
            {sortedOrphans.map((pkg: OrphanPackage) => (
              <Tr key={pkg.name}>
                <Td dataLabel="Package">{pkg.name}</Td>
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
      </CardBody>

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
    </Card>
  );
};
