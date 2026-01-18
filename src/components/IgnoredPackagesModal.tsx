import React, { useState, useEffect, useCallback, useRef } from "react";
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
  Spinner,
  Alert,
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
import { TrashIcon, TimesIcon } from "@patternfly/react-icons";
import {
  listIgnoredPackages,
  removeIgnoredPackage,
  addIgnoredPackage,
  searchPackages,
  SearchResult,
  getSyncPackageInfo,
  SyncPackageDetails,
  getPackageInfo,
} from "../api";
import { sanitizeErrorMessage } from "../utils";
import { SEARCH_DEBOUNCE_MS } from "../constants";

interface IgnoredPackagesModalProps {
  isOpen: boolean;
  onClose: () => void;
  onIgnoredChange?: (packages: string[]) => void;
}

export const IgnoredPackagesModal: React.FC<IgnoredPackagesModalProps> = ({
  isOpen,
  onClose,
  onIgnoredChange,
}) => {
  const [ignoredPackages, setIgnoredPackages] = useState<string[]>([]);
  const [packageVersions, setPackageVersions] = useState<Record<string, string>>({});
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [searchFilter, setSearchFilter] = useState("");
  const [adding, setAdding] = useState(false);
  const [removing, setRemoving] = useState<string | null>(null);

  // Typeahead state
  const [typeaheadOpen, setTypeaheadOpen] = useState(false);
  const [typeaheadValue, setTypeaheadValue] = useState("");
  const [suggestions, setSuggestions] = useState<SearchResult[]>([]);
  const [loadingSuggestions, setLoadingSuggestions] = useState(false);
  const [selectedPackage, setSelectedPackage] = useState<SearchResult | null>(null);
  const [previewPackage, setPreviewPackage] = useState<SyncPackageDetails | null>(null);
  const [loadingPreview, setLoadingPreview] = useState(false);

  const textInputRef = useRef<HTMLInputElement | null>(null);
  const debouncedTypeahead = useDebouncedValue(typeaheadValue, SEARCH_DEBOUNCE_MS);

  const loadIgnoredPackages = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const response = await listIgnoredPackages();
      setIgnoredPackages(response.packages);
    } catch (ex) {
      setError(ex instanceof Error ? ex.message : String(ex));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    if (isOpen) {
      loadIgnoredPackages();
      setTypeaheadValue("");
      setSelectedPackage(null);
      setPreviewPackage(null);
      setSuggestions([]);
    }
  }, [isOpen, loadIgnoredPackages]);

  useEffect(() => {
    if (ignoredPackages.length === 0) {
      setPackageVersions({});
      return;
    }

    const fetchVersions = async () => {
      const versions: Record<string, string> = {};
      await Promise.all(
        ignoredPackages.map(async (pkg) => {
          try {
            const info = await getPackageInfo(pkg);
            versions[pkg] = info.version;
          } catch {
            versions[pkg] = "not installed";
          }
        })
      );
      setPackageVersions(versions);
    };

    fetchVersions();
  }, [ignoredPackages]);

  // Fetch suggestions when typeahead value changes
  useEffect(() => {
    if (!debouncedTypeahead || debouncedTypeahead.length < 2) {
      setSuggestions([]);
      return;
    }

    const fetchSuggestions = async () => {
      setLoadingSuggestions(true);
      try {
        const response = await searchPackages({
          query: debouncedTypeahead,
          limit: 20,
          installed: "all",
        });
        setSuggestions(response.results);
      } catch {
        setSuggestions([]);
      } finally {
        setLoadingSuggestions(false);
      }
    };

    fetchSuggestions();
  }, [debouncedTypeahead]);

  // Load preview when a package is selected
  useEffect(() => {
    if (!selectedPackage) {
      setPreviewPackage(null);
      return;
    }

    const fetchPreview = async () => {
      setLoadingPreview(true);
      try {
        const details = await getSyncPackageInfo(selectedPackage.name, selectedPackage.repository);
        setPreviewPackage(details);
      } catch {
        setPreviewPackage(null);
      } finally {
        setLoadingPreview(false);
      }
    };

    fetchPreview();
  }, [selectedPackage]);

  const handleAddPackage = async () => {
    if (!selectedPackage) return;

    setAdding(true);
    setError(null);
    try {
      await addIgnoredPackage(selectedPackage.name);
      setTypeaheadValue("");
      setSelectedPackage(null);
      setPreviewPackage(null);
      setSuggestions([]);
      await loadIgnoredPackages();
      onIgnoredChange?.(ignoredPackages);
    } catch (ex) {
      setError(ex instanceof Error ? ex.message : String(ex));
    } finally {
      setAdding(false);
    }
  };

  const handleRemovePackage = async (packageName: string) => {
    setRemoving(packageName);
    setError(null);
    try {
      await removeIgnoredPackage(packageName);
      await loadIgnoredPackages();
      onIgnoredChange?.(ignoredPackages);
    } catch (ex) {
      setError(ex instanceof Error ? ex.message : String(ex));
    } finally {
      setRemoving(null);
    }
  };

  const handleTypeaheadSelect = (
    _event: React.MouseEvent<Element, MouseEvent> | undefined,
    value: string | number | undefined
  ) => {
    if (typeof value === "string") {
      const pkg = suggestions.find((s) => s.name === value);
      if (pkg) {
        setSelectedPackage(pkg);
        setTypeaheadValue(pkg.name);
        setTypeaheadOpen(false);
      }
    }
  };

  const handleTypeaheadClear = () => {
    setTypeaheadValue("");
    setSelectedPackage(null);
    setPreviewPackage(null);
    setSuggestions([]);
    textInputRef.current?.focus();
  };

  const filteredPackages = ignoredPackages.filter((pkg) =>
    pkg.toLowerCase().includes(searchFilter.toLowerCase())
  );

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
          onChange={(_event, value) => {
            setTypeaheadValue(value);
            setSelectedPackage(null);
            setPreviewPackage(null);
            if (!typeaheadOpen) {
              setTypeaheadOpen(true);
            }
          }}
          autoComplete="off"
          innerRef={textInputRef}
          placeholder="Search for package..."
          role="combobox"
          isExpanded={typeaheadOpen}
          aria-controls="ignored-packages-typeahead"
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
    >
      <ModalHeader title="Ignored Packages" />
      <ModalBody>
        {error && (
          <Alert
            variant="danger"
            title="Error"
            isInline
            className="pf-v6-u-mb-md"
          >
            {sanitizeErrorMessage(error)}
          </Alert>
        )}

        <Toolbar className="pf-v6-u-px-0 pf-v6-u-pb-md">
          <ToolbarContent>
            <ToolbarItem style={{ flex: 1 }}>
              <Flex spaceItems={{ default: "spaceItemsSm" }} alignItems={{ default: "alignItemsFlexStart" }}>
                <FlexItem style={{ flex: 1, maxWidth: "400px" }}>
                  <Select
                    id="ignored-packages-typeahead"
                    isOpen={typeaheadOpen}
                    selected={selectedPackage?.name}
                    onSelect={handleTypeaheadSelect}
                    onOpenChange={setTypeaheadOpen}
                    toggle={toggle}
                  >
                    <SelectList>
                      {loadingSuggestions ? (
                        <SelectOption isDisabled>
                          <Spinner size="sm" /> Searching...
                        </SelectOption>
                      ) : suggestions.length === 0 && typeaheadValue.length >= 2 ? (
                        <SelectOption isDisabled>No packages found</SelectOption>
                      ) : (
                        suggestions.map((pkg) => {
                          const isIgnored = ignoredPackages.includes(pkg.name);
                          return (
                            <SelectOption
                              key={`${pkg.repository}/${pkg.name}`}
                              value={pkg.name}
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
                  <Button
                    variant="primary"
                    onClick={handleAddPackage}
                    isLoading={adding}
                    isDisabled={adding || !selectedPackage || ignoredPackages.includes(selectedPackage.name)}
                  >
                    Ignore Package
                  </Button>
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
                  <span>Loading package info...</span>
                </Flex>
              ) : previewPackage ? (
                <>
                  <Flex spaceItems={{ default: "spaceItemsSm" }} alignItems={{ default: "alignItemsCenter" }}>
                    <FlexItem>
                      <strong>{previewPackage.name}</strong>
                    </FlexItem>
                    <FlexItem>
                      <Label color="blue" isCompact>{previewPackage.repository}</Label>
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
                    <Label color="blue" isCompact>{selectedPackage.repository}</Label>
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
                  placeholder="Filter ignored..."
                  value={searchFilter}
                  onChange={(_event, value) => setSearchFilter(value)}
                  onClear={() => setSearchFilter("")}
                />
              </ToolbarItem>
            </ToolbarContent>
          </Toolbar>
        )}

        {loading ? (
          <EmptyState headingLevel="h4" icon={Spinner} titleText="Loading ignored packages" />
        ) : ignoredPackages.length === 0 ? (
          <EmptyState headingLevel="h4" titleText="No ignored packages">
            <EmptyStateBody>
              Ignored packages will be excluded from system upgrades.
              Search for a package above to ignore it.
            </EmptyStateBody>
          </EmptyState>
        ) : (
          <Table aria-label="Ignored packages" variant="compact">
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
                    <Button
                      variant="plain"
                      aria-label={`Unignore ${pkg}`}
                      onClick={() => handleRemovePackage(pkg)}
                      isLoading={removing === pkg}
                      isDisabled={removing === pkg}
                    >
                      <TrashIcon />
                    </Button>
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
