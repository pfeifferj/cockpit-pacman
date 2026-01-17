import React, { useState, useEffect, useCallback } from "react";
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
} from "@patternfly/react-core";
import { Table, Thead, Tr, Th, Tbody, Td } from "@patternfly/react-table";
import { TrashIcon } from "@patternfly/react-icons";
import {
  listIgnoredPackages,
  removeIgnoredPackage,
  addIgnoredPackage,
} from "../api";

interface PinnedPackagesModalProps {
  isOpen: boolean;
  onClose: () => void;
  onPinnedChange?: (packages: string[]) => void;
}

export const PinnedPackagesModal: React.FC<PinnedPackagesModalProps> = ({
  isOpen,
  onClose,
  onPinnedChange,
}) => {
  const [pinnedPackages, setPinnedPackages] = useState<string[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [searchFilter, setSearchFilter] = useState("");
  const [addPackageName, setAddPackageName] = useState("");
  const [adding, setAdding] = useState(false);
  const [removing, setRemoving] = useState<string | null>(null);

  const loadPinnedPackages = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const response = await listIgnoredPackages();
      setPinnedPackages(response.packages);
    } catch (ex) {
      setError(ex instanceof Error ? ex.message : String(ex));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    if (isOpen) {
      loadPinnedPackages();
    }
  }, [isOpen, loadPinnedPackages]);

  const handleAddPackage = async () => {
    if (!addPackageName.trim()) return;

    setAdding(true);
    setError(null);
    try {
      await addIgnoredPackage(addPackageName.trim());
      setAddPackageName("");
      await loadPinnedPackages();
      onPinnedChange?.(pinnedPackages);
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
      await loadPinnedPackages();
      onPinnedChange?.(pinnedPackages);
    } catch (ex) {
      setError(ex instanceof Error ? ex.message : String(ex));
    } finally {
      setRemoving(null);
    }
  };

  const filteredPackages = pinnedPackages.filter((pkg) =>
    pkg.toLowerCase().includes(searchFilter.toLowerCase())
  );

  return (
    <Modal
      variant={ModalVariant.medium}
      isOpen={isOpen}
      onClose={onClose}
    >
      <ModalHeader title="Pinned Packages" />
      <ModalBody>
        {error && (
          <Alert
            variant="danger"
            title="Error"
            isInline
            className="pf-v6-u-mb-md"
          >
            {error}
          </Alert>
        )}

        <Toolbar className="pf-v6-u-px-0 pf-v6-u-pb-md">
          <ToolbarContent>
            <ToolbarItem>
              <Flex spaceItems={{ default: "spaceItemsSm" }}>
                <FlexItem>
                  <SearchInput
                    placeholder="Add package to pin..."
                    value={addPackageName}
                    onChange={(_event, value) => setAddPackageName(value)}
                    onClear={() => setAddPackageName("")}
                    onKeyDown={(e) => {
                      if (e.key === "Enter") {
                        handleAddPackage();
                      }
                    }}
                  />
                </FlexItem>
                <FlexItem>
                  <Button
                    variant="primary"
                    onClick={handleAddPackage}
                    isLoading={adding}
                    isDisabled={adding || !addPackageName.trim()}
                  >
                    Pin Package
                  </Button>
                </FlexItem>
              </Flex>
            </ToolbarItem>
            {pinnedPackages.length > 0 && (
              <ToolbarItem>
                <SearchInput
                  placeholder="Filter pinned..."
                  value={searchFilter}
                  onChange={(_event, value) => setSearchFilter(value)}
                  onClear={() => setSearchFilter("")}
                />
              </ToolbarItem>
            )}
          </ToolbarContent>
        </Toolbar>

        {loading ? (
          <EmptyState headingLevel="h4" icon={Spinner} titleText="Loading pinned packages" />
        ) : pinnedPackages.length === 0 ? (
          <EmptyState headingLevel="h4" titleText="No pinned packages">
            <EmptyStateBody>
              Pinned packages will be excluded from system upgrades.
              Add a package name above to pin it.
            </EmptyStateBody>
          </EmptyState>
        ) : (
          <Table aria-label="Pinned packages" variant="compact">
            <Thead>
              <Tr>
                <Th>Package</Th>
                <Th screenReaderText="Actions" />
              </Tr>
            </Thead>
            <Tbody>
              {filteredPackages.map((pkg) => (
                <Tr key={pkg}>
                  <Td dataLabel="Package">{pkg}</Td>
                  <Td dataLabel="Actions" isActionCell>
                    <Button
                      variant="plain"
                      aria-label={`Unpin ${pkg}`}
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
