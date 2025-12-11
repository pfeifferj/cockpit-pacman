import React, { useState, useEffect, useCallback, useRef, useMemo } from "react";
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
  SearchInput,
  Toolbar,
  ToolbarContent,
  ToolbarItem,
  Label,
  MenuToggle,
  MenuToggleElement,
  Select,
  SelectOption,
  SelectList,
  Modal,
  ModalVariant,
  List,
  ListItem,
  TextContent,
  Text,
  TextVariants,
} from "@patternfly/react-core";
import {
  CheckCircleIcon,
  SyncAltIcon,
} from "@patternfly/react-icons";
import { Table, Thead, Tr, Th, Tbody, Td, ThProps } from "@patternfly/react-table";
import {
  UpdateInfo,
  SyncPackageDetails,
  PreflightResponse,
  checkUpdates,
  runUpgrade,
  syncDatabase,
  getSyncPackageInfo,
  preflightUpgrade,
  formatSize,
} from "../api";
import { PackageDetailsModal } from "./PackageDetailsModal";

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
  const logContainerRef = useRef<HTMLDivElement | null>(null);
  const [selectedPackage, setSelectedPackage] = useState<SyncPackageDetails | null>(null);
  const [packageLoading, setPackageLoading] = useState(false);
  const [searchFilter, setSearchFilter] = useState("");
  const [repoFilter, setRepoFilter] = useState("all");
  const [repoSelectOpen, setRepoSelectOpen] = useState(false);
  const [confirmModalOpen, setConfirmModalOpen] = useState(false);
  const [preflightData, setPreflightData] = useState<PreflightResponse | null>(null);
  const [preflightLoading, setPreflightLoading] = useState(false);
  const [activeSortIndex, setActiveSortIndex] = useState<number | null>(null);
  const [activeSortDirection, setActiveSortDirection] = useState<"asc" | "desc">("asc");

  const repositories = useMemo(() => {
    const repos = new Set(updates.map((u) => u.repository));
    return Array.from(repos).sort();
  }, [updates]);

  const filteredUpdates = useMemo(() => {
    let result = updates;
    if (searchFilter) {
      const search = searchFilter.toLowerCase();
      result = result.filter(
        (u) =>
          u.name.toLowerCase().includes(search) ||
          u.current_version.toLowerCase().includes(search) ||
          u.new_version.toLowerCase().includes(search)
      );
    }
    if (repoFilter !== "all") {
      result = result.filter((u) => u.repository === repoFilter);
    }
    return result;
  }, [updates, searchFilter, repoFilter]);

  // Column indices: 0=name, 1=repository, 2=current_version, 3=new_version, 4=download_size
  const sortableColumns = [0, 1, 4]; // name, repository, download_size

  const getSortParams = (columnIndex: number): ThProps["sort"] | undefined => {
    if (!sortableColumns.includes(columnIndex)) return undefined;
    return {
      sortBy: {
        index: activeSortIndex ?? undefined,
        direction: activeSortDirection,
      },
      onSort: (_event, index, direction) => {
        setActiveSortIndex(index);
        setActiveSortDirection(direction);
      },
      columnIndex,
    };
  };

  const sortedUpdates = useMemo(() => {
    if (activeSortIndex === null) return filteredUpdates;

    return [...filteredUpdates].sort((a, b) => {
      let comparison = 0;
      switch (activeSortIndex) {
        case 0: // name
          comparison = a.name.localeCompare(b.name);
          break;
        case 1: // repository
          comparison = a.repository.localeCompare(b.repository);
          break;
        case 4: // download_size
          comparison = a.download_size - b.download_size;
          break;
        default:
          return 0;
      }
      return activeSortDirection === "asc" ? comparison : -comparison;
    });
  }, [filteredUpdates, activeSortIndex, activeSortDirection]);

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

  // Auto-scroll log to bottom when new content is added
  useEffect(() => {
    if (logContainerRef.current) {
      logContainerRef.current.scrollTop = logContainerRef.current.scrollHeight;
    }
  }, [log]);

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

  const handleApplyUpdates = async () => {
    // Run preflight check first
    setPreflightLoading(true);
    setError(null);
    try {
      const preflight = await preflightUpgrade();
      setPreflightData(preflight);
      setPreflightLoading(false);

      if (!preflight.success) {
        setError(preflight.error || "Preflight check failed");
        setState("error");
        return;
      }

      // Check if there are any issues that need confirmation
      const hasIssues =
        preflight.conflicts.length > 0 ||
        preflight.replacements.length > 0 ||
        preflight.removals.length > 0 ||
        preflight.providers.length > 0 ||
        preflight.import_keys.length > 0;

      if (hasIssues) {
        // Show confirmation modal
        setConfirmModalOpen(true);
        return;
      }

      // No issues - proceed directly
      startUpgrade();
    } catch (ex) {
      setPreflightLoading(false);
      setError(ex instanceof Error ? ex.message : String(ex));
      setState("error");
    }
  };

  const startUpgrade = () => {
    setConfirmModalOpen(false);
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

  const handlePackageClick = async (pkgName: string) => {
    setPackageLoading(true);
    try {
      const details = await getSyncPackageInfo(pkgName);
      setSelectedPackage(details);
    } catch (ex) {
      console.error("Failed to load package details:", ex);
    } finally {
      setPackageLoading(false);
    }
  };

  const handleCloseModal = () => {
    setSelectedPackage(null);
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
          <div ref={logContainerRef} style={{ marginTop: "1rem", maxHeight: "400px", overflow: "auto" }}>
            <CodeBlock>
              <CodeBlockCode>{log || "Starting upgrade..."}</CodeBlockCode>
            </CodeBlock>
          </div>
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
              {filteredUpdates.length !== updates.length && ` (${filteredUpdates.length} shown)`}
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
            <Button
              variant="primary"
              onClick={handleApplyUpdates}
              isLoading={preflightLoading}
              isDisabled={preflightLoading}
            >
              {preflightLoading ? "Checking..." : "Apply Updates"}
            </Button>
          </FlexItem>
        </Flex>

        <Toolbar style={{ paddingLeft: 0, paddingRight: 0 }}>
          <ToolbarContent>
            <ToolbarItem variant="search-filter">
              <SearchInput
                placeholder="Filter updates..."
                value={searchFilter}
                onChange={(_event: React.SyntheticEvent, value: string) => setSearchFilter(value)}
                onClear={() => setSearchFilter("")}
              />
            </ToolbarItem>
            {repositories.length > 1 && (
              <ToolbarItem>
                <Select
                  isOpen={repoSelectOpen}
                  selected={repoFilter}
                  onSelect={(_event: React.MouseEvent | undefined, value: string | number | undefined) => {
                    setRepoFilter(value as string);
                    setRepoSelectOpen(false);
                  }}
                  onOpenChange={setRepoSelectOpen}
                  toggle={(toggleRef: React.Ref<MenuToggleElement>) => (
                    <MenuToggle
                      ref={toggleRef}
                      onClick={() => setRepoSelectOpen(!repoSelectOpen)}
                      isExpanded={repoSelectOpen}
                    >
                      {repoFilter === "all" ? "All repositories" : repoFilter}
                    </MenuToggle>
                  )}
                >
                  <SelectList>
                    <SelectOption value="all">All repositories</SelectOption>
                    {repositories.map((repo) => (
                      <SelectOption key={repo} value={repo}>
                        {repo}
                      </SelectOption>
                    ))}
                  </SelectList>
                </Select>
              </ToolbarItem>
            )}
          </ToolbarContent>
        </Toolbar>

        <Table aria-label="Available updates" variant="compact">
          <Thead>
            <Tr>
              <Th sort={getSortParams(0)}>Package</Th>
              <Th sort={getSortParams(1)}>Repository</Th>
              <Th>Current Version</Th>
              <Th>New Version</Th>
              <Th sort={getSortParams(4)}>Download Size</Th>
            </Tr>
          </Thead>
          <Tbody>
            {sortedUpdates.map((update) => (
              <Tr
                key={update.name}
                isClickable
                onRowClick={() => handlePackageClick(update.name)}
              >
                <Td dataLabel="Package">
                  <Button variant="link" isInline style={{ padding: 0 }}>
                    {update.name}
                  </Button>
                </Td>
                <Td dataLabel="Repository">
                  <Label color="blue">{update.repository}</Label>
                </Td>
                <Td dataLabel="Current Version">{update.current_version}</Td>
                <Td dataLabel="New Version">{update.new_version}</Td>
                <Td dataLabel="Download Size">{formatSize(update.download_size)}</Td>
              </Tr>
            ))}
          </Tbody>
        </Table>
      </CardBody>

      <PackageDetailsModal
        packageDetails={selectedPackage}
        isLoading={packageLoading}
        onClose={handleCloseModal}
      />

      <Modal
        variant={ModalVariant.medium}
        title="Confirm Upgrade"
        isOpen={confirmModalOpen}
        onClose={() => setConfirmModalOpen(false)}
        actions={[
          <Button key="confirm" variant="primary" onClick={startUpgrade}>
            Proceed with Upgrade
          </Button>,
          <Button key="cancel" variant="link" onClick={() => setConfirmModalOpen(false)}>
            Cancel
          </Button>,
        ]}
      >
        {preflightData && (
          <TextContent>
            <Text component={TextVariants.p}>
              The following actions will be performed during this upgrade:
            </Text>

            {preflightData.conflicts.length > 0 && (
              <>
                <Text component={TextVariants.h4}>Package Conflicts</Text>
                <List>
                  {preflightData.conflicts.map((c, i) => (
                    <ListItem key={i}>
                      {c.package1} conflicts with {c.package2}
                    </ListItem>
                  ))}
                </List>
              </>
            )}

            {preflightData.replacements.length > 0 && (
              <>
                <Text component={TextVariants.h4}>Package Replacements</Text>
                <List>
                  {preflightData.replacements.map((r, i) => (
                    <ListItem key={i}>
                      {r.old_package} will be replaced by {r.new_package}
                    </ListItem>
                  ))}
                </List>
              </>
            )}

            {preflightData.removals.length > 0 && (
              <>
                <Text component={TextVariants.h4}>Packages to Remove</Text>
                <List>
                  {preflightData.removals.map((pkg, i) => (
                    <ListItem key={i}>{pkg}</ListItem>
                  ))}
                </List>
              </>
            )}

            {preflightData.providers.length > 0 && (
              <>
                <Text component={TextVariants.h4}>Provider Selections</Text>
                <List>
                  {preflightData.providers.map((p, i) => (
                    <ListItem key={i}>
                      {p.dependency}: {p.providers[0]} will be selected (from: {p.providers.join(", ")})
                    </ListItem>
                  ))}
                </List>
              </>
            )}

            {preflightData.import_keys.length > 0 && (
              <>
                <Text component={TextVariants.h4}>PGP Keys to Import</Text>
                <List>
                  {preflightData.import_keys.map((k, i) => (
                    <ListItem key={i}>
                      {k.fingerprint} ({k.uid})
                    </ListItem>
                  ))}
                </List>
              </>
            )}

            <Text component={TextVariants.p} style={{ marginTop: "1rem" }}>
              <strong>{preflightData.packages_to_upgrade}</strong> packages will be upgraded
              (download: {formatSize(preflightData.total_download_size)})
            </Text>
          </TextContent>
        )}
      </Modal>
    </Card>
  );
};
