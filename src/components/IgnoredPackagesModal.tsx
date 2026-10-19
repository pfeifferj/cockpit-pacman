import React, { useState, useEffect, useCallback, useRef, useId } from "react";
import { useBackdropClose } from "../hooks/useBackdropClose";
import { useDebouncedValue } from "../hooks/useDebounce";
import {
  Modal,
  ModalVariant,
  ModalHeader,
  ModalBody,
  ModalFooter,
  Button,
  EmptyState,
  EmptyStateBody,
  EmptyStateActions,
  Spinner,
  Alert,
  AlertActionLink,
  AlertGroup,
  SearchInput,
  Toolbar,
  ToolbarContent,
  ToolbarItem,
  Flex,
  FlexItem,
  Select,
  SelectOption,
  SelectList,
  MenuToggle,
  MenuToggleElement,
  TextInputGroup,
  TextInputGroupMain,
  TextInputGroupUtilities,
  Label,
  Card,
  CardBody,
  Content,
  ContentVariants,
} from "@patternfly/react-core";
import { Table, Thead, Tr, Th, Tbody, Td } from "@patternfly/react-table";
import { ExclamationCircleIcon, TimesIcon } from "@patternfly/react-icons";
import {
  listIgnoredPackages,
  removeIgnoredPackage,
  addIgnoredPackage,
  searchPackages,
  SearchResult,
  getSyncPackageInfo,
  SyncPackageDetails,
  getPackageInfo,
  BackendError,
} from "../api";
import { ignoreNotice, sanitizeErrorMessage } from "../utils";
import { SEARCH_DEBOUNCE_MS } from "../constants";
import { useAdminPermission } from "../hooks/useAdminPermission";
import { useMutationGate } from "../hooks/useMutationGate";
import { GatedButton } from "./GatedButton";
import { UndoAlert } from "./UndoAlert";
import { useAnnounce } from "../contexts/AnnouncerContext";
import { ErrorDetails } from "./ErrorDetails";

type IgnoreChange = { name: string; ignored: boolean };

interface IgnoredPackagesModalProps {
  isOpen: boolean;
  onClose: () => void;
  onIgnoredChange?: (packages: string[]) => void;
  /** Filter text applied when the modal opens. */
  initialFilter?: string;
  /** Package whose Unignore receives focus once the list has loaded. */
  focusName?: string;
}

export const IgnoredPackagesModal: React.FC<IgnoredPackagesModalProps> = ({
  isOpen,
  onClose,
  onIgnoredChange,
  initialFilter,
  focusName,
}) => {
  useBackdropClose(isOpen, onClose);
  const titleId = useId();
  const [ignoredPackages, setIgnoredPackages] = useState<string[]>([]);
  const [packageVersions, setPackageVersions] = useState<Record<string, string>>({});
  const [loading, setLoading] = useState(false);
  const [loaded, setLoaded] = useState(false);
  const loadedRef = useRef(false);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [loadErrorDetails, setLoadErrorDetails] = useState<string | undefined>();
  const [error, setError] = useState<{ title: string; message: string } | null>(null);
  const [searchFilter, setSearchFilter] = useState("");
  const [adding, setAdding] = useState(false);
  const [removing, setRemoving] = useState<string | null>(null);
  const [lastChange, setLastChange] = useState<IgnoreChange | null>(null);
  const [focusRequest, setFocusRequest] = useState(0);
  const pendingFocus = useRef<{ row: string | null } | null>(null);
  const gate = useMutationGate("change ignored packages", { permission: useAdminPermission() });

  const announce = useAnnounce();

  const [typeaheadOpen, setTypeaheadOpen] = useState(false);
  const [focusedSuggestion, setFocusedSuggestion] = useState<number | null>(null);
  const [typeaheadValue, setTypeaheadValue] = useState("");
  const [suggestions, setSuggestions] = useState<SearchResult[]>([]);
  const [loadingSuggestions, setLoadingSuggestions] = useState(false);
  const [selectedPackage, setSelectedPackage] = useState<SearchResult | null>(null);
  const [previewPackage, setPreviewPackage] = useState<SyncPackageDetails | null>(null);
  const [loadingPreview, setLoadingPreview] = useState(false);

  const textInputRef = useRef<HTMLInputElement | null>(null);
  const filterInputRef = useRef<HTMLInputElement | null>(null);
  const rowButtons = useRef(new Map<string, React.ComponentRef<"button">>());
  const debouncedTypeahead = useDebouncedValue(typeaheadValue, SEARCH_DEBOUNCE_MS);
  const suggestionIdPrefix = useId();

  const loadIgnoredPackages = useCallback(async (): Promise<string[] | null> => {
    setLoading(true);
    try {
      const response = await listIgnoredPackages();
      if (response.packages === null) throw new Error("Saved package ignores are unavailable");
      setIgnoredPackages(response.packages);
      loadedRef.current = true;
      setLoaded(true);
      setLoadError(null);
      setLoadErrorDetails(undefined);
      return response.packages;
    } catch (ex) {
      setLoadError(ex instanceof Error ? ex.message : String(ex));
      setLoadErrorDetails(ex instanceof BackendError ? ex.details : undefined);
      if (!loadedRef.current) announce("Could not load ignored packages");
      return null;
    } finally {
      setLoading(false);
    }
  }, [announce]);

  useEffect(() => {
    if (!isOpen) return;
    Promise.resolve().then(() => {
      setTypeaheadValue("");
      setSelectedPackage(null);
      setPreviewPackage(null);
      setSuggestions([]);
      setError(null);
      setLoadError(null);
      setLoadErrorDetails(undefined);
      setLoaded(false);
      loadedRef.current = false;
      setLastChange(null);
      setSearchFilter(initialFilter ?? "");
      pendingFocus.current = focusName ? { row: focusName } : null;
      void loadIgnoredPackages().then(() => setFocusRequest((n) => n + 1));
    });
  }, [isOpen, initialFilter, focusName, loadIgnoredPackages]);

  // A pending focus target waits for the first successful load, so a failed
  // load keeps focus on its Try again.
  useEffect(() => {
    const target = pendingFocus.current;
    if (!target || loading || !loaded) return;
    pendingFocus.current = null;
    const row = target.row !== null ? rowButtons.current.get(target.row) : undefined;
    (row ?? filterInputRef.current ?? textInputRef.current)?.focus();
  }, [focusRequest, loading, loaded]);

  useEffect(() => {
    if (ignoredPackages.length === 0) {
      Promise.resolve().then(() => setPackageVersions({}));
      return;
    }
    let cancelled = false;
    Promise.all(
      ignoredPackages.map(async (pkg) => {
        try {
          const info = await getPackageInfo(pkg);
          return [pkg, info.version] as const;
        } catch {
          return [pkg, "not installed"] as const;
        }
      })
    ).then((entries) => {
      if (cancelled) return;
      setPackageVersions(Object.fromEntries(entries));
    });
    return () => { cancelled = true; };
  }, [ignoredPackages]);

  useEffect(() => {
    if (!debouncedTypeahead || debouncedTypeahead.length < 2) {
      Promise.resolve().then(() => setSuggestions([]));
      return;
    }
    let cancelled = false;
    searchPackages({
      query: debouncedTypeahead,
      limit: 20,
      installed: "all",
    })
      .then((response) => {
        if (cancelled) return;
        setSuggestions(response.results);
        setFocusedSuggestion(null);
        setLoadingSuggestions(false);
      })
      .catch(() => {
        if (cancelled) return;
        setSuggestions([]);
        setLoadingSuggestions(false);
      });
    return () => { cancelled = true; };
  }, [debouncedTypeahead]);

  useEffect(() => {
    if (!selectedPackage) {
      Promise.resolve().then(() => setPreviewPackage(null));
      return;
    }
    let cancelled = false;
    getSyncPackageInfo(selectedPackage.name, selectedPackage.repository)
      .then((details) => {
        if (cancelled) return;
        setPreviewPackage(details);
        setLoadingPreview(false);
      })
      .catch(() => {
        if (cancelled) return;
        setPreviewPackage(null);
        setLoadingPreview(false);
      });
    return () => { cancelled = true; };
  }, [selectedPackage]);

  const matchesFilter = (pkg: string) => pkg.toLowerCase().includes(searchFilter.toLowerCase());
  const filteredPackages = ignoredPackages.filter(matchesFilter);
  const busy = adding || removing !== null;
  const loadBlock = !loaded ? "Load the ignored packages first"
    : loadError !== null ? "Reload the ignored packages before changing them"
      : loading ? "Wait for the ignored packages to load" : undefined;

  const applyChange = async (change: IgnoreChange): Promise<string[] | null> => {
    const { name, ignored } = change;
    try {
      await (ignored ? addIgnoredPackage(name) : removeIgnoredPackage(name));
    } catch (ex) {
      setLastChange(null);
      setError({
        title: ignored ? `Could not ignore ${name}` : `Could not unignore ${name}`,
        message: ex instanceof Error ? ex.message : String(ex),
      });
      return null;
    }
    setError(null);
    setLastChange(change);
    const reloaded = await loadIgnoredPackages();
    const list = reloaded ?? (ignored
      ? [...ignoredPackages.filter((p) => p !== name), name]
      : ignoredPackages.filter((p) => p !== name));
    onIgnoredChange?.(list);
    return list;
  };

  const handleAddPackage = async () => {
    if (!selectedPackage || busy || gate.blocked || loadBlock) return;

    setAdding(true);
    const list = await applyChange({ name: selectedPackage.name, ignored: true });
    if (list) {
      setTypeaheadValue("");
      setSelectedPackage(null);
      setPreviewPackage(null);
      setSuggestions([]);
    }
    setAdding(false);
    textInputRef.current?.focus();
  };

  const handleRemovePackage = async (packageName: string) => {
    if (busy || gate.blocked || loadBlock) return;
    const index = filteredPackages.indexOf(packageName);
    setRemoving(packageName);
    const list = await applyChange({ name: packageName, ignored: false });
    setRemoving(null);
    if (!list) return;
    const remaining = list.filter(matchesFilter);
    const next = remaining.find((p) => filteredPackages.indexOf(p) > index)
      ?? [...remaining].reverse().find((p) => filteredPackages.indexOf(p) >= 0 && filteredPackages.indexOf(p) < index)
      ?? null;
    pendingFocus.current = { row: next };
    setFocusRequest((n) => n + 1);
  };

  const handleUndo = () => {
    if (!lastChange || busy || gate.blocked || loadBlock) return;
    const inverse = { name: lastChange.name, ignored: !lastChange.ignored };
    if (inverse.ignored) setAdding(true);
    else setRemoving(inverse.name);
    void applyChange(inverse).finally(() => {
      setAdding(false);
      setRemoving(null);
    });
  };

  const retryLoad = () => {
    if (loading) return;
    pendingFocus.current ??= { row: null };
    void loadIgnoredPackages().then(() => setFocusRequest((n) => n + 1));
  };

  const selectSuggestion = (pkg: SearchResult) => {
    setSelectedPackage(pkg);
    setTypeaheadValue(pkg.name);
    setTypeaheadOpen(false);
    setFocusedSuggestion(null);
  };

  const selectable = (index: number) => !ignoredPackages.includes(suggestions[index].name);

  const moveSuggestionFocus = (step: 1 | -1) => {
    const count = suggestions.length;
    let index = focusedSuggestion ?? (step === 1 ? -1 : count);
    for (let tried = 0; tried < count; tried++) {
      index = (index + step + count) % count;
      if (selectable(index)) {
        setFocusedSuggestion(index);
        return;
      }
    }
  };

  const handleTypeaheadKeyDown = (event: React.KeyboardEvent) => {
    if (event.key === "ArrowDown" || event.key === "ArrowUp") {
      event.preventDefault();
      if (!typeaheadOpen) setTypeaheadOpen(true);
      if (!loadingSuggestions) moveSuggestionFocus(event.key === "ArrowDown" ? 1 : -1);
    } else if (event.key === "Enter" && typeaheadOpen && focusedSuggestion !== null) {
      event.preventDefault();
      const pkg = suggestions[focusedSuggestion];
      if (pkg) selectSuggestion(pkg);
    }
  };

  const handleTypeaheadSelect = (
    _event: React.MouseEvent<Element, MouseEvent> | undefined,
    value: string | number | undefined
  ) => {
    if (typeof value === "string") {
      const pkg = suggestions.find((s) => s.name === value);
      if (pkg) selectSuggestion(pkg);
    }
  };

  const handleTypeaheadClear = () => {
    setTypeaheadValue("");
    setSelectedPackage(null);
    setPreviewPackage(null);
    setSuggestions([]);
    setFocusedSuggestion(null);
    textInputRef.current?.focus();
  };

  const toggle = (toggleRef: React.Ref<MenuToggleElement>) => (
    <MenuToggle
      ref={toggleRef}
      variant="typeahead"
      onClick={() => setTypeaheadOpen(!typeaheadOpen)}
      isExpanded={typeaheadOpen}
      isFullWidth
    >
      <TextInputGroup isPlain>
        <TextInputGroupMain
          value={typeaheadValue}
          onClick={() => setTypeaheadOpen(true)}
          onKeyDown={handleTypeaheadKeyDown}
          onChange={(_event, value) => {
            setTypeaheadValue(value);
            setSelectedPackage(null);
            setPreviewPackage(null);
            setFocusedSuggestion(null);
            if (!typeaheadOpen) {
              setTypeaheadOpen(true);
            }
          }}
          autoComplete="off"
          innerRef={textInputRef}
          placeholder="Search for package…"
          role="combobox"
          isExpanded={typeaheadOpen}
          aria-controls="ignored-packages-typeahead"
          aria-activedescendant={typeaheadOpen && focusedSuggestion !== null
            ? `${suggestionIdPrefix}-${focusedSuggestion}` : undefined}
        />
        {typeaheadValue && (
          <TextInputGroupUtilities>
            <Button
              variant="plain"
              onClick={handleTypeaheadClear}
              aria-label="Clear input"
            >
              <TimesIcon />
            </Button>
          </TextInputGroupUtilities>
        )}
      </TextInputGroup>
    </MenuToggle>
  );

  return (
    <Modal
      variant={ModalVariant.medium}
      isOpen={isOpen}
      onClose={onClose}
      aria-labelledby={titleId}
    >
      <ModalHeader title="Ignored packages" labelId={titleId} />
      <ModalBody>
        <AlertGroup isLiveRegion>
          {error && (
            <Alert
              component="h2"
              variant="danger"
              title={error.title}
              isInline
              className="pf-v6-u-mb-md"
            >
              {sanitizeErrorMessage(error.message)}
            </Alert>
          )}
          {loaded && loadError && (
            <Alert
              component="h2"
              variant="danger"
              title="Could not load ignored packages"
              isInline
              className="pf-v6-u-mb-md"
              actionLinks={
                <AlertActionLink onClick={retryLoad}>Try again</AlertActionLink>
              }
            >
              {sanitizeErrorMessage(loadError)}
              <ErrorDetails details={loadErrorDetails} />
            </Alert>
          )}
        </AlertGroup>
        <UndoAlert
          headingLevel="h2"
          title={lastChange && ignoreNotice(lastChange.name, lastChange.ignored)}
          onUndo={handleUndo}
          gate={gate}
          disabledReason={loadBlock || (busy && "Wait for the current change to finish")}
          onClose={() => setLastChange(null)}
        />

        <Toolbar className="pf-v6-u-px-0 pf-v6-u-pb-md">
          <ToolbarContent>
            <ToolbarItem style={{ flex: 1 }}>
              <Flex spaceItems={{ default: "spaceItemsSm" }} alignItems={{ default: "alignItemsFlexStart" }}>
                <FlexItem style={{ flex: 1, maxWidth: "400px" }}>
                  <Select
                    id="ignored-packages-typeahead"
                    variant="typeahead"
                    isOpen={typeaheadOpen}
                    selected={selectedPackage?.name}
                    onSelect={handleTypeaheadSelect}
                    onOpenChange={setTypeaheadOpen}
                    toggle={toggle}
                    popperProps={{ appendTo: "inline" }}
                  >
                    <SelectList>
                      {loadingSuggestions ? (
                        <SelectOption isDisabled>
                          <Spinner size="sm" /> Searching…
                        </SelectOption>
                      ) : suggestions.length === 0 && typeaheadValue.length >= 2 ? (
                        <SelectOption isDisabled>No packages found</SelectOption>
                      ) : (
                        suggestions.map((pkg, index) => {
                          const isIgnored = ignoredPackages.includes(pkg.name);
                          return (
                            <SelectOption
                              key={`${pkg.repository}/${pkg.name}`}
                              id={`${suggestionIdPrefix}-${index}`}
                              value={pkg.name}
                              isFocused={focusedSuggestion === index}
                              isDisabled={isIgnored}
                              description={`${pkg.version} - ${pkg.repository}${isIgnored ? " (already ignored)" : ""}`}
                            >
                              {pkg.name}
                            </SelectOption>
                          );
                        })
                      )}
                    </SelectList>
                  </Select>
                </FlexItem>
                <FlexItem>
                  <GatedButton
                    variant="primary"
                    onClick={handleAddPackage}
                    isLoading={adding}
                    gate={gate}
                    disabledReason={
                      loadBlock || (!selectedPackage ? "Choose a package to ignore"
                        : ignoredPackages.includes(selectedPackage.name) ? `${selectedPackage.name} is already ignored`
                          : busy && "Wait for the current change to finish")
                    }
                  >
                    Ignore package
                  </GatedButton>
                </FlexItem>
              </Flex>
            </ToolbarItem>
          </ToolbarContent>
        </Toolbar>

        {selectedPackage && (
          <Card isCompact className="pf-v6-u-mb-md">
            <CardBody>
              {loadingPreview ? (
                <Flex alignItems={{ default: "alignItemsCenter" }} spaceItems={{ default: "spaceItemsSm" }}>
                  <Spinner size="md" />
                  <span>Loading package info…</span>
                </Flex>
              ) : previewPackage ? (
                <>
                  <Flex spaceItems={{ default: "spaceItemsSm" }} alignItems={{ default: "alignItemsCenter" }}>
                    <FlexItem>
                      <strong>{previewPackage.name}</strong>
                    </FlexItem>
                    <FlexItem>
                      <Label isCompact color="grey">{previewPackage.repository}</Label>
                    </FlexItem>
                    <FlexItem>
                      <span style={{ color: "var(--pf-t--global--text--color--subtle)" }}>
                        {previewPackage.version}
                      </span>
                    </FlexItem>
                  </Flex>
                  {previewPackage.description && (
                    <Content component={ContentVariants.p} className="pf-v6-u-mt-sm pf-v6-u-mb-0">
                      {previewPackage.description}
                    </Content>
                  )}
                </>
              ) : (
                <Flex spaceItems={{ default: "spaceItemsSm" }} alignItems={{ default: "alignItemsCenter" }}>
                  <FlexItem>
                    <strong>{selectedPackage.name}</strong>
                  </FlexItem>
                  <FlexItem>
                    <Label isCompact color="grey">{selectedPackage.repository}</Label>
                  </FlexItem>
                </Flex>
              )}
            </CardBody>
          </Card>
        )}

        {ignoredPackages.length > 0 && (
          <Toolbar className="pf-v6-u-px-0 pf-v6-u-pb-sm">
            <ToolbarContent>
              <ToolbarItem>
                <SearchInput
                  ref={filterInputRef}
                  aria-label="Filter ignored packages"
                  placeholder="Filter ignored…"
                  value={searchFilter}
                  onChange={(_event, value) => setSearchFilter(value)}
                  onClear={() => setSearchFilter("")}
                />
              </ToolbarItem>
            </ToolbarContent>
          </Toolbar>
        )}

        {!loaded && loadError !== null ? (
          <EmptyState
            headingLevel="h2"
            icon={ExclamationCircleIcon}
            status="danger"
            titleText="Could not load ignored packages"
          >
            <EmptyStateBody>
              {sanitizeErrorMessage(loadError)}
              <ErrorDetails details={loadErrorDetails} />
            </EmptyStateBody>
            <EmptyStateActions>
              <Button variant="secondary" onClick={retryLoad} isLoading={loading}>
                Try again
              </Button>
            </EmptyStateActions>
          </EmptyState>
        ) : !loaded || (loading && ignoredPackages.length === 0) ? (
          <EmptyState headingLevel="h2" icon={Spinner} titleText="Loading ignored packages" />
        ) : ignoredPackages.length === 0 ? (
          <EmptyState headingLevel="h2" titleText="No ignored packages">
            <EmptyStateBody>
              Ignored packages will be excluded from system upgrades.
              Search for a package above to ignore it.
            </EmptyStateBody>
          </EmptyState>
        ) : (
          <Table aria-label="Ignored packages" variant="compact" aria-busy={loading}>
            <Thead>
              <Tr>
                <Th>Package</Th>
                <Th>Version</Th>
                <Th screenReaderText="Actions" />
              </Tr>
            </Thead>
            <Tbody>
              {filteredPackages.map((pkg) => (
                <Tr key={pkg}>
                  <Td dataLabel="Package">{pkg}</Td>
                  <Td dataLabel="Version">
                    <span style={{ color: packageVersions[pkg] === "not installed" ? "var(--pf-t--global--text--color--subtle)" : undefined }}>
                      {packageVersions[pkg] || "-"}
                    </span>
                  </Td>
                  <Td dataLabel="Actions" isActionCell>
                    <GatedButton
                      ref={(el: React.ComponentRef<"button"> | null) => {
                        if (el) rowButtons.current.set(pkg, el);
                        else rowButtons.current.delete(pkg);
                      }}
                      variant="link"
                      isInline
                      aria-label={`Unignore ${pkg}`}
                      onClick={() => handleRemovePackage(pkg)}
                      isLoading={removing === pkg}
                      gate={gate}
                      disabledReason={loadBlock || (busy && "Wait for the current change to finish")}
                    >
                      Unignore
                    </GatedButton>
                  </Td>
                </Tr>
              ))}
            </Tbody>
          </Table>
        )}
      </ModalBody>
      <ModalFooter>
        <Button variant="secondary" onClick={onClose}>
          Close
        </Button>
      </ModalFooter>
    </Modal>
  );
};
