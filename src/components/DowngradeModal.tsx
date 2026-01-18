import React, { useState, useEffect, useCallback, useRef } from "react";
import { LOG_CONTAINER_HEIGHT } from "../constants";
import {
  Modal,
  ModalVariant,
  ModalHeader,
  ModalBody,
  ModalFooter,
  Button,
  Spinner,
  Alert,
  EmptyState,
  EmptyStateBody,
  Label,
  CodeBlock,
  CodeBlockCode,
  ExpandableSection,
  Content,
  ContentVariants,
} from "@patternfly/react-core";
import { Table, Thead, Tr, Th, Tbody, Td, ThProps } from "@patternfly/react-table";
import { ArrowDownIcon, CheckCircleIcon } from "@patternfly/react-icons";
import {
  CachedVersion,
  listDowngrades,
  downgradePackage,
  formatSize,
} from "../api";
import { sanitizeErrorMessage } from "../utils";

type ModalState = "loading" | "select" | "confirm" | "downgrading" | "success" | "error";

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
  const [state, setState] = useState<ModalState>("loading");
  const [versions, setVersions] = useState<CachedVersion[]>([]);
  const [selectedVersion, setSelectedVersion] = useState<CachedVersion | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [log, setLog] = useState("");
  const [isDetailsExpanded, setIsDetailsExpanded] = useState(false);
  const [activeSortIndex, setActiveSortIndex] = useState<number | null>(null);
  const [activeSortDirection, setActiveSortDirection] = useState<"asc" | "desc">("desc");
  const cancelRef = useRef<(() => void) | null>(null);
  const logContainerRef = useRef<HTMLDivElement | null>(null);

  const loadVersions = useCallback(async () => {
    if (!packageName) return;
    setState("loading");
    setError(null);
    try {
      const response = await listDowngrades(packageName);
      const olderVersions = response.packages.filter((v) => v.is_older);
      setVersions(olderVersions);
      setState("select");
    } catch (ex) {
      setState("error");
      setError(ex instanceof Error ? ex.message : String(ex));
    }
  }, [packageName]);

  useEffect(() => {
    if (isOpen) {
      loadVersions();
      setSelectedVersion(null);
      setLog("");
    }
  }, [isOpen, loadVersions]);

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

    const { cancel } = downgradePackage(
      {
        onData: (data) => setLog((prev) => prev + data),
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
      packageName,
      selectedVersion.version
    );
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
    if (columnIndex !== 0 && columnIndex !== 1) return undefined;
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
        case 1:
          comparison = a.size - b.size;
          break;
        default:
          return 0;
      }
      return activeSortDirection === "asc" ? comparison : -comparison;
    });
  }, [versions, activeSortIndex, activeSortDirection]);

  const renderContent = () => {
    switch (state) {
      case "loading":
        return (
          <EmptyState headingLevel="h3" icon={Spinner} titleText="Loading cached versions">
            <EmptyStateBody>Scanning package cache...</EmptyStateBody>
          </EmptyState>
        );

      case "error":
        return (
          <Alert variant="danger" title="Error">
            {sanitizeErrorMessage(error)}
          </Alert>
        );

      case "select":
        if (versions.length === 0) {
          return (
            <EmptyState headingLevel="h3" titleText="No older versions available">
              <EmptyStateBody>
                No older versions of {packageName} were found in the package cache.
                Only versions older than {currentVersion} can be used for downgrade.
              </EmptyStateBody>
            </EmptyState>
          );
        }
        return (
          <>
            <Content component={ContentVariants.p} className="pf-v6-u-mb-md">
              Select a version to downgrade <strong>{packageName}</strong> from{" "}
              <Label color="blue">{currentVersion}</Label>
            </Content>
            <Table aria-label="Available versions" variant="compact">
              <Thead>
                <Tr>
                  <Th sort={getSortParams(0)}>Version</Th>
                  <Th sort={getSortParams(1)}>Size</Th>
                  <Th>Action</Th>
                </Tr>
              </Thead>
              <Tbody>
                {sortedVersions.map((v) => (
                  <Tr key={v.filename}>
                    <Td dataLabel="Version">
                      <code>{v.version}</code>
                    </Td>
                    <Td dataLabel="Size">{formatSize(v.size)}</Td>
                    <Td dataLabel="Action">
                      <Button
                        variant="secondary"
                        size="sm"
                        icon={<ArrowDownIcon />}
                        onClick={() => handleSelectVersion(v)}
                      >
                        Downgrade
                      </Button>
                    </Td>
                  </Tr>
                ))}
              </Tbody>
            </Table>
          </>
        );

      case "confirm":
        return (
          <Content>
            <Content component={ContentVariants.p}>
              Are you sure you want to downgrade <strong>{packageName}</strong>?
            </Content>
            <Content component={ContentVariants.p} className="pf-v6-u-mt-md">
              <Label color="blue">{currentVersion}</Label>
              {" -> "}
              <Label color="orange">{selectedVersion?.version}</Label>
            </Content>
            <Alert variant="warning" title="Warning" className="pf-v6-u-mt-md">
              Downgrading packages may cause dependency issues or break functionality.
              Only proceed if you know what you are doing.
            </Alert>
          </Content>
        );

      case "downgrading":
        return (
          <>
            <div className="pf-v6-u-mb-md">
              <Spinner size="md" /> Downgrading {packageName} to {selectedVersion?.version}...
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

      case "success":
        return (
          <EmptyState headingLevel="h3" icon={CheckCircleIcon} titleText="Downgrade complete">
            <EmptyStateBody>
              {packageName} has been downgraded to {selectedVersion?.version}.
            </EmptyStateBody>
          </EmptyState>
        );

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
              Confirm Downgrade
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
            <Button variant="primary" onClick={loadVersions}>
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
