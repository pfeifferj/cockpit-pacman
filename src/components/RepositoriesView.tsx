import React, { useState, useEffect, useCallback, useMemo } from "react";
import {
  Card,
  CardBody,
  CardTitle,
  Button,
  EmptyState,
  EmptyStateBody,
  EmptyStateActions,
  EmptyStateFooter,
  Spinner,
  Flex,
  FlexItem,
  SearchInput,
  Toolbar,
  ToolbarContent,
  ToolbarItem,
  Switch,
  FormSelect,
  FormSelectOption,
  Label,
  TextInput,
  Modal,
  ModalVariant,
  ModalHeader,
  ModalBody,
  ModalFooter,
} from "@patternfly/react-core";
import {
  GlobeIcon,
  CheckCircleIcon,
  ExclamationCircleIcon,
  ArrowUpIcon,
  ArrowDownIcon,
  TrashIcon,
  AngleRightIcon,
  AngleDownIcon,
} from "@patternfly/react-icons";
import {
  Table,
  Thead,
  Tr,
  Th,
  Tbody,
  Td,
} from "@patternfly/react-table";
import { StatBox } from "./StatBox";
import {
  RepoEntry,
  ListReposResponse,
  listRepos,
  saveRepos,
  formatNumber,
} from "../api";
import { sanitizeErrorMessage } from "../utils";

type ViewState = "loading" | "ready" | "saving" | "success" | "error";

const SIG_LEVEL_OPTIONS = [
  { value: "", label: "Default" },
  { value: "Never", label: "Never" },
  { value: "Optional", label: "Optional" },
  { value: "Required", label: "Required" },
  { value: "Required DatabaseOptional", label: "Required DatabaseOptional" },
  { value: "TrustedOnly", label: "TrustedOnly" },
];

const KNOWN_SIG_LEVELS = new Set(SIG_LEVEL_OPTIONS.map((o) => o.value));

export const RepositoriesView: React.FC = () => {
  const [state, setState] = useState<ViewState>("loading");
  const [repos, setRepos] = useState<RepoEntry[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [hasChanges, setHasChanges] = useState(false);
  const [searchFilter, setSearchFilter] = useState("");
  const [pendingSearchFilter, setPendingSearchFilter] = useState<string | null>(null);
  const [expandedRepos, setExpandedRepos] = useState<Set<string>>(new Set());
  const [newDirectiveTypes, setNewDirectiveTypes] = useState<
    Record<string, "Server" | "Include">
  >({});
  const [newDirectiveValues, setNewDirectiveValues] = useState<
    Record<string, string>
  >({});

  const loadRepos = useCallback(async () => {
    setState("loading");
    setError(null);
    try {
      const response: ListReposResponse = await listRepos();
      setRepos(response.repos);
      setHasChanges(false);
      setState("ready");
    } catch (ex) {
      setState("error");
      setError(ex instanceof Error ? ex.message : String(ex));
    }
  }, []);

  useEffect(() => {
    loadRepos();
  }, [loadRepos]);

  const handleSave = async () => {
    setState("saving");
    try {
      await saveRepos(repos);
      setState("success");
      setHasChanges(false);
    } catch (ex) {
      setState("error");
      setError(ex instanceof Error ? ex.message : String(ex));
    }
  };

  const handleToggleEnabled = (index: number) => {
    setRepos((prev) =>
      prev.map((r, i) => (i === index ? { ...r, enabled: !r.enabled } : r)),
    );
    setHasChanges(true);
  };

  const handleSigLevelChange = (index: number, value: string) => {
    setRepos((prev) =>
      prev.map((r, i) =>
        i === index ? { ...r, sig_level: value || null } : r,
      ),
    );
    setHasChanges(true);
  };

  const swapByName = (a: string, b: string) => {
    setRepos((prev) => {
      const next = [...prev];
      const i = next.findIndex((r) => r.name === a);
      const j = next.findIndex((r) => r.name === b);
      if (i < 0 || j < 0) return prev;
      [next[i], next[j]] = [next[j], next[i]];
      return next;
    });
    setHasChanges(true);
  };

  const handleToggleExpand = (repoName: string) => {
    setExpandedRepos((prev) => {
      const next = new Set(prev);
      if (next.has(repoName)) {
        next.delete(repoName);
      } else {
        next.add(repoName);
      }
      return next;
    });
  };

  const handleToggleDirectiveEnabled = (
    repoIndex: number,
    directiveIndex: number,
  ) => {
    setRepos((prev) =>
      prev.map((r, ri) =>
        ri === repoIndex
          ? {
              ...r,
              directives: r.directives.map((d, di) =>
                di === directiveIndex ? { ...d, enabled: !d.enabled } : d,
              ),
            }
          : r,
      ),
    );
    setHasChanges(true);
  };

  const handleRemoveDirective = (
    repoIndex: number,
    directiveIndex: number,
  ) => {
    setRepos((prev) =>
      prev.map((r, ri) =>
        ri === repoIndex
          ? {
              ...r,
              directives: r.directives.filter((_, di) => di !== directiveIndex),
            }
          : r,
      ),
    );
    setHasChanges(true);
  };

  const handleAddDirective = (repoName: string, repoIndex: number) => {
    const dtype = newDirectiveTypes[repoName] || "Server";
    const value = newDirectiveValues[repoName]?.trim();
    if (!value) return;
    setRepos((prev) =>
      prev.map((r, ri) =>
        ri === repoIndex
          ? {
              ...r,
              directives: [
                ...r.directives,
                { directive_type: dtype, value, enabled: true },
              ],
            }
          : r,
      ),
    );
    setNewDirectiveValues((prev) => ({ ...prev, [repoName]: "" }));
    setHasChanges(true);
  };

  const visibleRepos = useMemo(
    () => repos.filter((r) => r.name !== "repo-name"),
    [repos],
  );

  const enabledCount = useMemo(
    () => visibleRepos.filter((r) => r.enabled).length,
    [visibleRepos],
  );

  const filteredRepos = useMemo(() => {
    if (!searchFilter) return visibleRepos;
    const lower = searchFilter.toLowerCase();
    return visibleRepos.filter((r) => r.name.toLowerCase().includes(lower));
  }, [visibleRepos, searchFilter]);

  if (state === "loading") {
    return (
      <Card>
        <CardBody>
          <EmptyState
            headingLevel="h2"
            icon={Spinner}
            titleText="Loading repositories"
          >
            <EmptyStateBody>
              Reading repository configuration...
            </EmptyStateBody>
          </EmptyState>
        </CardBody>
      </Card>
    );
  }

  if (state === "error" && repos.length === 0) {
    return (
      <Card>
        <CardBody>
          <EmptyState
            headingLevel="h2"
            icon={ExclamationCircleIcon}
            titleText="Error loading repositories"
            status="danger"
          >
            <EmptyStateBody>{sanitizeErrorMessage(error)}</EmptyStateBody>
            <EmptyStateFooter>
              <EmptyStateActions>
                <Button variant="primary" onClick={loadRepos}>
                  Retry
                </Button>
              </EmptyStateActions>
            </EmptyStateFooter>
          </EmptyState>
        </CardBody>
      </Card>
    );
  }

  if (state === "saving") {
    return (
      <Card>
        <CardBody>
          <EmptyState
            headingLevel="h2"
            icon={Spinner}
            titleText="Saving repositories"
          >
            <EmptyStateBody>
              Writing repository configuration...
            </EmptyStateBody>
          </EmptyState>
        </CardBody>
      </Card>
    );
  }

  if (state === "success") {
    return (
      <Card>
        <CardBody>
          <EmptyState
            headingLevel="h2"
            icon={CheckCircleIcon}
            titleText="Repositories saved"
          >
            <EmptyStateBody>
              The repository configuration has been saved. A backup was created.
            </EmptyStateBody>
            <EmptyStateFooter>
              <EmptyStateActions>
                <Button variant="primary" onClick={loadRepos}>
                  View Repositories
                </Button>
              </EmptyStateActions>
            </EmptyStateFooter>
          </EmptyState>
        </CardBody>
      </Card>
    );
  }

  if (repos.length === 0) {
    return (
      <Card>
        <CardBody>
          <EmptyState
            headingLevel="h2"
            icon={GlobeIcon}
            titleText="No repositories found"
          >
            <EmptyStateBody>
              No repository sections were found in pacman.conf.
            </EmptyStateBody>
            <EmptyStateFooter>
              <EmptyStateActions>
                <Button variant="secondary" onClick={loadRepos}>
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
    <>
    <Card>
      <CardBody>
        <Flex justifyContent={{ default: "justifyContentSpaceBetween" }} alignItems={{ default: "alignItemsFlexStart" }}>
          <FlexItem>
            <CardTitle className="pf-v6-u-m-0">Pacman Repositories</CardTitle>
            <Flex spaceItems={{ default: "spaceItemsLg" }} className="pf-v6-u-mb-md pf-v6-u-mt-sm">
              <FlexItem>
                <StatBox label="Total" value={formatNumber(visibleRepos.length)} />
              </FlexItem>
              <FlexItem>
                <StatBox label="Enabled" value={formatNumber(enabledCount)} color="success" />
              </FlexItem>
            </Flex>
          </FlexItem>
        </Flex>

        <Toolbar>
          <ToolbarContent>
            <ToolbarItem>
              <SearchInput
                placeholder="Search repositories..."
                value={searchFilter}
                onChange={(_event: React.SyntheticEvent, value: string) => {
                  if (hasChanges) {
                    setPendingSearchFilter(value);
                  } else {
                    setSearchFilter(value);
                  }
                }}
                onClear={() => {
                  if (hasChanges) {
                    setPendingSearchFilter("");
                  } else {
                    setSearchFilter("");
                  }
                }}
                aria-label="Search repositories"
              />
            </ToolbarItem>
            <ToolbarItem>
              <Button variant="primary" onClick={handleSave} isDisabled={!hasChanges}>
                Save Changes
              </Button>
            </ToolbarItem>
          </ToolbarContent>
        </Toolbar>

        <Table aria-label="Repository list" variant="compact">
          <Thead>
            <Tr>
              <Th width={10}>Enabled</Th>
              <Th>Repository</Th>
              <Th width={25}>SigLevel</Th>
              <Th width={10}>Servers</Th>
              <Th width={10}>Actions</Th>
            </Tr>
          </Thead>
          <Tbody>
            {filteredRepos.flatMap((repo) => {
              const actualIndex = repos.indexOf(repo);
              const visibleIdx = visibleRepos.indexOf(repo);
              const prevVisible = visibleIdx > 0 ? visibleRepos[visibleIdx - 1] : null;
              const nextVisible =
                visibleIdx >= 0 && visibleIdx < visibleRepos.length - 1
                  ? visibleRepos[visibleIdx + 1]
                  : null;
              const isExpanded = expandedRepos.has(repo.name);
              const sigValue = repo.sig_level || "";
              const isCustom =
                sigValue !== "" && !KNOWN_SIG_LEVELS.has(sigValue);
              const serverCount = repo.directives.length;

              const rows = [
                <Tr key={repo.name}>
                  <Td dataLabel="Enabled">
                    <Switch
                      id={`switch-${actualIndex}`}
                      isChecked={repo.enabled}
                      onChange={() => handleToggleEnabled(actualIndex)}
                      aria-label={`Enable repository ${repo.name}`}
                    />
                  </Td>
                  <Td dataLabel="Repository">
                    <Button
                      variant="plain"
                      className="pf-v6-u-p-0"
                      aria-label={`Expand ${repo.name}`}
                      aria-expanded={isExpanded}
                      onClick={() => handleToggleExpand(repo.name)}
                    >
                      <Flex alignItems={{ default: "alignItemsCenter" }} spaceItems={{ default: "spaceItemsSm" }}>
                        <FlexItem>{isExpanded ? <AngleDownIcon /> : <AngleRightIcon />}</FlexItem>
                        <FlexItem>
                          <span style={{ fontFamily: "var(--pf-t--global--font--family--mono)" }}>
                            [{repo.name}]
                          </span>
                        </FlexItem>
                      </Flex>
                    </Button>
                  </Td>
                  <Td dataLabel="SigLevel">
                    <FormSelect
                      value={isCustom ? "__custom__" : sigValue}
                      onChange={(_event, value) => {
                        if (value !== "__custom__") {
                          handleSigLevelChange(actualIndex, value);
                        }
                      }}
                      aria-label={`SigLevel for ${repo.name}`}
                    >
                      {SIG_LEVEL_OPTIONS.map((opt) => (
                        <FormSelectOption
                          key={opt.value}
                          value={opt.value}
                          label={opt.label}
                        />
                      ))}
                      {isCustom && (
                        <FormSelectOption
                          key="__custom__"
                          value="__custom__"
                          label={`Custom: ${sigValue}`}
                          isDisabled
                        />
                      )}
                    </FormSelect>
                  </Td>
                  <Td dataLabel="Servers">
                    <Label isCompact>{serverCount}</Label>
                  </Td>
                  <Td dataLabel="Actions">
                    <Flex spaceItems={{ default: "spaceItemsXs" }}>
                      <FlexItem>
                        <Button
                          variant="plain"
                          aria-label="Move up"
                          onClick={() => prevVisible && swapByName(repo.name, prevVisible.name)}
                          isDisabled={!prevVisible}
                        >
                          <ArrowUpIcon />
                        </Button>
                      </FlexItem>
                      <FlexItem>
                        <Button
                          variant="plain"
                          aria-label="Move down"
                          onClick={() => nextVisible && swapByName(repo.name, nextVisible.name)}
                          isDisabled={!nextVisible}
                        >
                          <ArrowDownIcon />
                        </Button>
                      </FlexItem>
                    </Flex>
                  </Td>
                </Tr>,
              ];

              if (isExpanded) {
                rows.push(
                  <Tr key={`${repo.name}-directives`}>
                    <Td colSpan={5}>
                      <Table aria-label={`Directives for ${repo.name}`} variant="compact" borders={false}>
                        <Thead>
                          <Tr>
                            <Th width={10} screenReaderText="Active" />
                            <Th width={15}>Type</Th>
                            <Th>Value</Th>
                            <Th width={10} screenReaderText="Remove" />
                          </Tr>
                        </Thead>
                        <Tbody>
                          {repo.directives.map((directive, di) => (
                            <Tr key={`${directive.directive_type}-${di}`}>
                              <Td dataLabel="Active">
                                <Switch
                                  id={`directive-switch-${actualIndex}-${di}`}
                                  isChecked={directive.enabled}
                                  onChange={() => handleToggleDirectiveEnabled(actualIndex, di)}
                                  aria-label={`Enable directive ${directive.value}`}
                                />
                              </Td>
                              <Td dataLabel="Type">
                                <Label color={directive.directive_type === "Server" ? "blue" : "orange"} isCompact>
                                  {directive.directive_type}
                                </Label>
                              </Td>
                              <Td dataLabel="Value">
                                <span style={{ fontFamily: "var(--pf-t--global--font--family--mono)", fontSize: "0.875rem", opacity: directive.enabled ? 1 : 0.5 }}>
                                  {directive.value}
                                </span>
                              </Td>
                              <Td dataLabel="Remove">
                                <Button
                                  variant="plain"
                                  aria-label={`Remove directive ${directive.value}`}
                                  onClick={() => handleRemoveDirective(actualIndex, di)}
                                >
                                  <TrashIcon />
                                </Button>
                              </Td>
                            </Tr>
                          ))}
                          <Tr>
                            <Td />
                            <Td dataLabel="Type">
                              <FormSelect
                                value={newDirectiveTypes[repo.name] || "Server"}
                                onChange={(_event, value) =>
                                  setNewDirectiveTypes((prev) => ({
                                    ...prev,
                                    [repo.name]: value as "Server" | "Include",
                                  }))
                                }
                                aria-label="New directive type"
                              >
                                <FormSelectOption value="Server" label="Server" />
                                <FormSelectOption value="Include" label="Include" />
                              </FormSelect>
                            </Td>
                            <Td dataLabel="Value">
                              <TextInput
                                id={`add-directive-value-${repo.name}`}
                                value={newDirectiveValues[repo.name] || ""}
                                onChange={(_event, value) =>
                                  setNewDirectiveValues((prev) => ({
                                    ...prev,
                                    [repo.name]: value,
                                  }))
                                }
                                placeholder={
                                  (newDirectiveTypes[repo.name] || "Server") === "Server"
                                    ? "https://mirror.example.org/$repo/os/$arch"
                                    : "/etc/pacman.d/mirrorlist"
                                }
                                aria-label="New directive value"
                              />
                            </Td>
                            <Td dataLabel="Add">
                              <Button
                                variant="secondary"
                                onClick={() => handleAddDirective(repo.name, actualIndex)}
                                isDisabled={!newDirectiveValues[repo.name]?.trim()}
                              >
                                Add
                              </Button>
                            </Td>
                          </Tr>
                        </Tbody>
                      </Table>
                    </Td>
                  </Tr>,
                );
              }

              return rows;
            })}
          </Tbody>
        </Table>

      </CardBody>
    </Card>
    <Modal
      variant={ModalVariant.small}
      isOpen={pendingSearchFilter !== null}
      onClose={() => setPendingSearchFilter(null)}
      aria-labelledby="repo-filter-guard-title"
    >
      <ModalHeader title="Unsaved changes" labelId="repo-filter-guard-title" />
      <ModalBody>
        Repository configuration has unsaved changes. Switching the filter will discard them.
      </ModalBody>
      <ModalFooter>
        <Button
          variant="danger"
          onClick={async () => {
            const target = pendingSearchFilter ?? "";
            setPendingSearchFilter(null);
            await loadRepos();
            setSearchFilter(target);
          }}
        >
          Discard and switch filter
        </Button>
        <Button variant="link" onClick={() => setPendingSearchFilter(null)}>
          Cancel
        </Button>
      </ModalFooter>
    </Modal>
    </>
  );
};
