import React, { useState, useEffect, useCallback, useRef } from "react";
import {
  Card,
  CardBody,
  CardTitle,
  Button,
  Alert,
  AlertActionCloseButton,
  EmptyState,
  EmptyStateHeader,
  EmptyStateIcon,
  EmptyStateBody,
  EmptyStateActions,
  EmptyStateFooter,
  Spinner,
  Progress,
  ProgressMeasureLocation,
  CodeBlock,
  CodeBlockCode,
  Flex,
  FlexItem,
} from "@patternfly/react-core";
import {
  CheckCircleIcon,
  SyncAltIcon,
} from "@patternfly/react-icons";
import { Table, Thead, Tr, Th, Tbody, Td } from "@patternfly/react-table";
import {
  UpdateInfo,
  checkUpdates,
  runUpgrade,
  syncDatabase,
  formatSize,
} from "../api";

type ViewState =
  | "loading"
  | "checking"
  | "uptodate"
  | "available"
  | "applying"
  | "success"
  | "error";

export const UpdatesView: React.FC = () => {
  const [state, setState] = useState<ViewState>("loading");
  const [updates, setUpdates] = useState<UpdateInfo[]>([]);
  const [log, setLog] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [warnings, setWarnings] = useState<string[]>([]);
  const cancelRef = useRef<(() => void) | null>(null);

  const loadUpdates = useCallback(async () => {
    setState("checking");
    setError(null);
    setWarnings([]);
    try {
      const response = await checkUpdates();
      setUpdates(response.updates);
      setWarnings(response.warnings);
      setState(response.updates.length > 0 ? "available" : "uptodate");
    } catch (ex) {
      setState("error");
      setError(ex instanceof Error ? ex.message : String(ex));
    }
  }, []);

  useEffect(() => {
    loadUpdates();
  }, [loadUpdates]);

  useEffect(() => {
    return () => {
      if (cancelRef.current) {
        cancelRef.current();
      }
    };
  }, []);

  const handleRefresh = async () => {
    setState("checking");
    setLog("");
    syncDatabase({
      onData: (data) => setLog((prev) => prev + data),
      onComplete: () => loadUpdates(),
      onError: (err) => {
        setState("error");
        setError(err);
      },
    });
  };

  const handleApplyUpdates = () => {
    setState("applying");
    setLog("");
    const { cancel } = runUpgrade({
      onData: (data) => setLog((prev) => prev + data),
      onComplete: () => {
        setState("success");
        setUpdates([]);
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
      setState("available");
      setLog("");
    }
  };

  const totalDownloadSize = updates.reduce((sum, u) => sum + u.download_size, 0);

  if (state === "loading" || state === "checking") {
    return (
      <Card>
        <CardBody>
          <EmptyState>
            <EmptyStateHeader
              titleText="Checking for updates"
              icon={<EmptyStateIcon icon={Spinner} />}
              headingLevel="h2"
            />
            <EmptyStateBody>
              Querying package databases...
            </EmptyStateBody>
          </EmptyState>
        </CardBody>
      </Card>
    );
  }

  if (state === "error") {
    return (
      <Card>
        <CardBody>
          <Alert
            variant="danger"
            title="Error checking for updates"
            actionClose={<AlertActionCloseButton onClose={() => setState("uptodate")} />}
          >
            {error}
          </Alert>
          <div style={{ marginTop: "1rem" }}>
            <Button variant="primary" onClick={loadUpdates}>
              Retry
            </Button>
          </div>
        </CardBody>
      </Card>
    );
  }

  if (state === "applying") {
    return (
      <Card>
        <CardBody>
          <Flex justifyContent={{ default: "justifyContentSpaceBetween" }} alignItems={{ default: "alignItemsCenter" }}>
            <FlexItem>
              <CardTitle style={{ margin: 0 }}>Applying Updates</CardTitle>
            </FlexItem>
            <FlexItem>
              <Button variant="danger" onClick={handleCancel}>
                Cancel
              </Button>
            </FlexItem>
          </Flex>
          <Progress
            value={undefined}
            measureLocation={ProgressMeasureLocation.none}
            aria-label="Applying updates"
            style={{ marginTop: "1rem" }}
          />
          <CodeBlock style={{ marginTop: "1rem", maxHeight: "400px", overflow: "auto" }}>
            <CodeBlockCode>{log || "Starting upgrade..."}</CodeBlockCode>
          </CodeBlock>
        </CardBody>
      </Card>
    );
  }

  if (state === "success") {
    return (
      <Card>
        <CardBody>
          <EmptyState>
            <EmptyStateHeader
              titleText="System Updated"
              icon={<EmptyStateIcon icon={CheckCircleIcon} color="green" />}
              headingLevel="h2"
            />
            <EmptyStateBody>
              All packages have been updated successfully.
            </EmptyStateBody>
            <EmptyStateFooter>
              <EmptyStateActions>
                <Button variant="primary" onClick={loadUpdates}>
                  Check Again
                </Button>
              </EmptyStateActions>
            </EmptyStateFooter>
          </EmptyState>
          {log && (
            <CodeBlock style={{ marginTop: "1rem", maxHeight: "300px", overflow: "auto" }}>
              <CodeBlockCode>{log}</CodeBlockCode>
            </CodeBlock>
          )}
        </CardBody>
      </Card>
    );
  }

  if (state === "uptodate") {
    return (
      <Card>
        <CardBody>
          {warnings.length > 0 && (
            <Alert variant="warning" title="Warnings" style={{ marginBottom: "1rem" }}>
              <ul style={{ margin: 0, paddingLeft: "1.5rem" }}>
                {warnings.map((w, i) => <li key={i}>{w}</li>)}
              </ul>
            </Alert>
          )}
          <EmptyState>
            <EmptyStateHeader
              titleText="System is up to date"
              icon={<EmptyStateIcon icon={CheckCircleIcon} color="green" />}
              headingLevel="h2"
            />
            <EmptyStateBody>
              All installed packages are at their latest versions.
            </EmptyStateBody>
            <EmptyStateFooter>
              <EmptyStateActions>
                <Button
                  variant="secondary"
                  icon={<SyncAltIcon />}
                  onClick={handleRefresh}
                >
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
        {warnings.length > 0 && (
          <Alert variant="warning" title="Warnings" style={{ marginBottom: "1rem" }}>
            <ul style={{ margin: 0, paddingLeft: "1.5rem" }}>
              {warnings.map((w, i) => <li key={i}>{w}</li>)}
            </ul>
          </Alert>
        )}
        <Flex justifyContent={{ default: "justifyContentSpaceBetween" }} alignItems={{ default: "alignItemsCenter" }}>
          <FlexItem>
            <CardTitle style={{ margin: 0 }}>
              {updates.length} update{updates.length !== 1 ? "s" : ""} available
            </CardTitle>
            <span style={{ color: "var(--pf-v5-global--Color--200)" }}>
              Total download: {formatSize(totalDownloadSize)}
            </span>
          </FlexItem>
          <FlexItem>
            <Button
              variant="secondary"
              icon={<SyncAltIcon />}
              onClick={handleRefresh}
              style={{ marginRight: "0.5rem" }}
            >
              Refresh
            </Button>
            <Button variant="primary" onClick={handleApplyUpdates}>
              Apply Updates
            </Button>
          </FlexItem>
        </Flex>

        <Table aria-label="Available updates" variant="compact" style={{ marginTop: "1rem" }}>
          <Thead>
            <Tr>
              <Th>Package</Th>
              <Th>Current Version</Th>
              <Th>New Version</Th>
              <Th>Download Size</Th>
            </Tr>
          </Thead>
          <Tbody>
            {updates.map((update) => (
              <Tr key={update.name}>
                <Td dataLabel="Package">{update.name}</Td>
                <Td dataLabel="Current Version">{update.current_version}</Td>
                <Td dataLabel="New Version">{update.new_version}</Td>
                <Td dataLabel="Download Size">{formatSize(update.download_size)}</Td>
              </Tr>
            ))}
          </Tbody>
        </Table>
      </CardBody>
    </Card>
  );
};
