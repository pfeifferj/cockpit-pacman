import React, { useState, useEffect, useCallback, useRef, useMemo } from "react";
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
  SearchInput,
  Toolbar,
  ToolbarContent,
  ToolbarItem,
  Label,
  ExpandableSection,
  MenuToggle,
  MenuToggleElement,
  Select,
  SelectOption,
  SelectList,
} from "@patternfly/react-core";
import { SyncAltIcon, KeyIcon } from "@patternfly/react-icons";
import { Table, Thead, Tr, Th, Tbody, Td, ThProps } from "@patternfly/react-table";
import {
  KeyringKey,
  KeyringStatusResponse,
  getKeyringStatus,
  refreshKeyring,
  initKeyring,
} from "../api";

type ViewState = "loading" | "ready" | "refreshing" | "initializing" | "error";

const MAX_LOG_SIZE = 100000; // 100KB limit for log buffer

export const KeyringView: React.FC = () => {
  const [state, setState] = useState<ViewState>("loading");
  const [keyringData, setKeyringData] = useState<KeyringStatusResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [log, setLog] = useState("");
  const [searchFilter, setSearchFilter] = useState("");
  const [trustFilter, setTrustFilter] = useState("all");
  const [trustSelectOpen, setTrustSelectOpen] = useState(false);
  const [activeSortIndex, setActiveSortIndex] = useState<number | null>(null);
  const [activeSortDirection, setActiveSortDirection] = useState<"asc" | "desc">("asc");
  const [isDetailsExpanded, setIsDetailsExpanded] = useState(false);
  const cancelRef = useRef<(() => void) | null>(null);
  const logContainerRef = useRef<HTMLDivElement | null>(null);

  const loadKeyringStatus = useCallback(async () => {
    setState("loading");
    setError(null);
    try {
      const response = await getKeyringStatus();
      setKeyringData(response);
      setState("ready");
    } catch (ex) {
      setState("error");
      setError(ex instanceof Error ? ex.message : String(ex));
    }
  }, []);

  useEffect(() => {
    loadKeyringStatus();
  }, [loadKeyringStatus]);

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

  const handleRefreshKeys = () => {
    setState("refreshing");
    setLog("");
    setIsDetailsExpanded(true);
    const { cancel } = refreshKeyring({
      onData: (data) => setLog((prev) => {
        const newLog = prev + data;
        return newLog.length > MAX_LOG_SIZE ? newLog.slice(-MAX_LOG_SIZE) : newLog;
      }),
      onComplete: () => {
        cancelRef.current = null;
        loadKeyringStatus();
      },
      onError: (err) => {
        setState("error");
        setError(err);
        cancelRef.current = null;
      },
    });
    cancelRef.current = cancel;
  };

  const handleInitKeyring = () => {
    setState("initializing");
    setLog("");
    setIsDetailsExpanded(true);
    const { cancel } = initKeyring({
      onData: (data) => setLog((prev) => {
        const newLog = prev + data;
        return newLog.length > MAX_LOG_SIZE ? newLog.slice(-MAX_LOG_SIZE) : newLog;
      }),
      onComplete: () => {
        cancelRef.current = null;
        loadKeyringStatus();
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

  const trustLevels = useMemo(() => {
    const levels = new Set(keyringData?.keys.map((k) => k.trust) ?? []);
    return Array.from(levels).sort();
  }, [keyringData]);

  const filteredKeys = useMemo(() => {
    let result = keyringData?.keys ?? [];
    if (searchFilter) {
      const search = searchFilter.toLowerCase();
      result = result.filter(
        (key) =>
          key.fingerprint.toLowerCase().includes(search) ||
          key.uid.toLowerCase().includes(search) ||
          key.trust.toLowerCase().includes(search)
      );
    }
    if (trustFilter !== "all") {
      result = result.filter((key) => key.trust === trustFilter);
    }
    return result;
  }, [keyringData, searchFilter, trustFilter]);

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

  const sortedKeys = [...filteredKeys].sort((a, b) => {
    if (activeSortIndex === null) return 0;
    let comparison = 0;
    switch (activeSortIndex) {
      case 0:
        comparison = a.fingerprint.localeCompare(b.fingerprint);
        break;
      case 1:
        comparison = a.uid.localeCompare(b.uid);
        break;
      case 2:
        comparison = a.trust.localeCompare(b.trust);
        break;
      default:
        return 0;
    }
    return activeSortDirection === "asc" ? comparison : -comparison;
  });

  const getTrustColor = (trust: string): "blue" | "green" | "orange" | "red" | "grey" => {
    switch (trust.toLowerCase()) {
      case "ultimate":
      case "full":
        return "green";
      case "marginal":
        return "orange";
      case "never":
        return "red";
      case "unknown":
      case "undefined":
      default:
        return "grey";
    }
  };

  if (state === "loading") {
    return (
      <Card>
        <CardBody>
          <EmptyState headingLevel="h2" icon={Spinner} titleText="Loading keyring status">
            <EmptyStateBody>Querying pacman keyring...</EmptyStateBody>
          </EmptyState>
        </CardBody>
      </Card>
    );
  }

  if (state === "error") {
    return (
      <Card>
        <CardBody>
          <Alert variant="danger" title="Error loading keyring status">
            {error}
          </Alert>
          <div style={{ marginTop: "1rem" }}>
            <Button variant="primary" onClick={loadKeyringStatus}>
              Retry
            </Button>
          </div>
        </CardBody>
      </Card>
    );
  }

  if (state === "refreshing" || state === "initializing") {
    const title = state === "initializing" ? "Initializing Keyring" : "Refreshing Keys";
    const subtitle = state === "initializing"
      ? "Creating master key and populating with Arch Linux keys..."
      : "Refreshing keys from keyserver...";

    return (
      <Card>
        <CardBody>
          <Flex justifyContent={{ default: "justifyContentSpaceBetween" }} alignItems={{ default: "alignItemsCenter" }}>
            <FlexItem>
              <CardTitle style={{ margin: 0 }}>{title}</CardTitle>
            </FlexItem>
            <FlexItem>
              <Button variant="danger" onClick={handleCancel}>
                Cancel
              </Button>
            </FlexItem>
          </Flex>

          <div style={{ marginTop: "1rem", marginBottom: "1rem" }}>
            <Spinner size="md" /> {subtitle}
          </div>

          <ExpandableSection
            toggleText={isDetailsExpanded ? "Hide details" : "Show details"}
            onToggle={(_event, expanded) => setIsDetailsExpanded(expanded)}
            isExpanded={isDetailsExpanded}
          >
            <div ref={logContainerRef} style={{ maxHeight: "300px", overflow: "auto" }}>
              <CodeBlock>
                <CodeBlockCode>{log || "Starting..."}</CodeBlockCode>
              </CodeBlock>
            </div>
          </ExpandableSection>
        </CardBody>
      </Card>
    );
  }

  if (!keyringData?.master_key_initialized) {
    return (
      <Card>
        <CardBody>
          {keyringData?.warnings.map((warning, i) => (
            <Alert key={i} variant="warning" title="Keyring Warning" style={{ marginBottom: "1rem" }}>
              {warning}
            </Alert>
          ))}
          <EmptyState headingLevel="h2" icon={KeyIcon} titleText="Keyring not initialized">
            <EmptyStateBody>
              The pacman keyring has not been initialized. Initialize it to verify package signatures.
            </EmptyStateBody>
            <EmptyStateFooter>
              <EmptyStateActions>
                <Button variant="primary" onClick={handleInitKeyring}>
                  Initialize Keyring
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
        {keyringData?.warnings.map((warning, i) => (
          <Alert key={i} variant="warning" title="Warning" style={{ marginBottom: "1rem" }}>
            {warning}
          </Alert>
        ))}

        <Flex justifyContent={{ default: "justifyContentSpaceBetween" }} alignItems={{ default: "alignItemsCenter" }}>
          <FlexItem>
            <CardTitle style={{ margin: 0 }}>
              {keyringData?.total ?? 0} key{(keyringData?.total ?? 0) !== 1 ? "s" : ""} in keyring
              {filteredKeys.length !== (keyringData?.total ?? 0) && ` (${filteredKeys.length} shown)`}
            </CardTitle>
          </FlexItem>
          <FlexItem>
            <Button variant="secondary" icon={<SyncAltIcon />} onClick={handleRefreshKeys}>
              Refresh Keys
            </Button>
          </FlexItem>
        </Flex>

        <Toolbar style={{ paddingLeft: 0, paddingRight: 0, marginTop: "1rem" }}>
          <ToolbarContent>
            <ToolbarItem>
              <SearchInput
                placeholder="Filter keys..."
                value={searchFilter}
                onChange={(_event: React.SyntheticEvent, value: string) => setSearchFilter(value)}
                onClear={() => setSearchFilter("")}
              />
            </ToolbarItem>
            {trustLevels.length > 1 && (
              <ToolbarItem>
                <Select
                  isOpen={trustSelectOpen}
                  selected={trustFilter}
                  onSelect={(_event: React.MouseEvent | undefined, value: string | number | undefined) => {
                    setTrustFilter(value as string);
                    setTrustSelectOpen(false);
                  }}
                  onOpenChange={setTrustSelectOpen}
                  toggle={(toggleRef: React.Ref<MenuToggleElement>) => (
                    <MenuToggle
                      ref={toggleRef}
                      onClick={() => setTrustSelectOpen(!trustSelectOpen)}
                      isExpanded={trustSelectOpen}
                    >
                      {trustFilter === "all" ? "All trust levels" : trustFilter}
                    </MenuToggle>
                  )}
                >
                  <SelectList>
                    <SelectOption value="all">All trust levels</SelectOption>
                    {trustLevels.map((level) => (
                      <SelectOption key={level} value={level}>
                        {level}
                      </SelectOption>
                    ))}
                  </SelectList>
                </Select>
              </ToolbarItem>
            )}
          </ToolbarContent>
        </Toolbar>

        <Table aria-label="Keyring keys" variant="compact">
          <Thead>
            <Tr>
              <Th sort={getSortParams(0)}>Fingerprint</Th>
              <Th sort={getSortParams(1)}>User ID</Th>
              <Th sort={getSortParams(2)}>Trust</Th>
              <Th>Created</Th>
              <Th>Expires</Th>
            </Tr>
          </Thead>
          <Tbody>
            {sortedKeys.map((key: KeyringKey) => (
              <Tr key={key.fingerprint}>
                <Td dataLabel="Fingerprint">
                  <code style={{ fontSize: "0.85em" }}>{key.fingerprint}</code>
                </Td>
                <Td dataLabel="User ID">{key.uid || "-"}</Td>
                <Td dataLabel="Trust">
                  <Label color={getTrustColor(key.trust)}>{key.trust}</Label>
                </Td>
                <Td dataLabel="Created">{key.created || "-"}</Td>
                <Td dataLabel="Expires">{key.expires || "-"}</Td>
              </Tr>
            ))}
          </Tbody>
        </Table>

        {sortedKeys.length === 0 && (
          <EmptyState headingLevel="h3" titleText="No keys found">
            <EmptyStateBody>
              {searchFilter || trustFilter !== "all"
                ? "No keys match your filter."
                : "The keyring contains no keys."}
            </EmptyStateBody>
          </EmptyState>
        )}
      </CardBody>
    </Card>
  );
};
