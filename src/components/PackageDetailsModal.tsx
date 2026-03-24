import React, { useState } from "react";
import { useBackdropClose } from "../hooks/useBackdropClose";
import {
	Spinner,
	DescriptionList,
	DescriptionListGroup,
	DescriptionListTerm,
	DescriptionListDescription,
	Label,
	LabelGroup,
	Popover,
	Icon,
	Modal,
	ModalVariant,
	ModalHeader,
	ModalBody,
	ModalFooter,
	Button,
	EmptyState,
	EmptyStateBody,
} from '@patternfly/react-core';
import { OutlinedQuestionCircleIcon, ArrowDownIcon, ExclamationCircleIcon, TopologyIcon, TrashIcon, PlusCircleIcon, HistoryIcon } from "@patternfly/react-icons";
import { PackageDetails, SyncPackageDetails, formatSize, formatDate } from "../api";
import { sanitizeUrl, sanitizeErrorMessage } from "../utils";
import { DowngradeModal } from "./DowngradeModal";
import { InstallModal } from "./InstallModal";
import { UninstallModal } from "./UninstallModal";

type PackageInfo = PackageDetails | SyncPackageDetails;

function isInstalledPackage(pkg: PackageInfo): pkg is PackageDetails {
  return "install_date" in pkg && "reason" in pkg && "validation" in pkg;
}

interface PackageDetailsModalProps {
  packageDetails: PackageInfo | null;
  isLoading: boolean;
  onClose: () => void;
  error?: string | null;
  onViewDependencies?: (packageName: string) => void;
  onViewHistory?: (packageName: string) => void;
  onPackageRemoved?: () => void;
  onPackageInstalled?: () => void;
}

export const PackageDetailsModal: React.FC<PackageDetailsModalProps> = ({
  packageDetails,
  isLoading,
  onClose,
  error,
  onViewDependencies,
  onViewHistory,
  onPackageRemoved,
  onPackageInstalled,
}) => {
  const [downgradeModalOpen, setDowngradeModalOpen] = useState(false);
  const [uninstallTarget, setUninstallTarget] = useState<{ name: string; version: string } | null>(null);
  const [installTarget, setInstallTarget] = useState<{ name: string; version: string } | null>(null);
  const isOpen = packageDetails !== null || isLoading || !!error;
  const isInstalled = packageDetails && isInstalledPackage(packageDetails);
  useBackdropClose(isOpen, onClose);

  const handleDowngradeClose = () => {
    setDowngradeModalOpen(false);
  };

  const handleUninstall = () => {
    if (!packageDetails) return;
    setUninstallTarget({ name: packageDetails.name, version: packageDetails.version });
    onClose();
  };

  const handleUninstallClose = () => {
    setUninstallTarget(null);
  };

  const handleInstall = () => {
    if (!packageDetails) return;
    setInstallTarget({ name: packageDetails.name, version: packageDetails.version });
    onClose();
  };

  const handleInstallClose = () => {
    setInstallTarget(null);
  };

  return (
    <>
    <Modal
      variant={ModalVariant.medium}
      isOpen={isOpen}
      onClose={onClose}
    >
      <ModalHeader title={
        packageDetails
          ? <>{packageDetails.name} <Label isCompact variant="outline">{packageDetails.version}</Label> <Label isCompact color="grey">{packageDetails.repository || "user"}</Label>{isInstalled && !packageDetails.repository && (
              <Popover
                headerContent="User Package"
                bodyContent="This package is not from an official repository. It may have been installed from the AUR, built manually with makepkg, or installed from a local PKGBUILD."
              >
                <Icon isInline style={{ marginLeft: "0.5em", cursor: "pointer" }}>
                  <OutlinedQuestionCircleIcon />
                </Icon>
              </Popover>
            )}</>
          : (error ? "Package Details" : "Loading...")
      } />
      <ModalBody>
        {isLoading ? (
          <Spinner />
        ) : error ? (
          <EmptyState headingLevel="h4" icon={ExclamationCircleIcon} titleText="Package not found">
            <EmptyStateBody>
              {sanitizeErrorMessage(error)}
            </EmptyStateBody>
          </EmptyState>
        ) : packageDetails ? (
          <DescriptionList>

          {/* Overview */}

          <DescriptionListGroup>
            <DescriptionListTerm>Description</DescriptionListTerm>
            <DescriptionListDescription>
              {packageDetails.description || "-"}
            </DescriptionListDescription>
          </DescriptionListGroup>

          {(() => {
            const safeUrl = sanitizeUrl(packageDetails.url);
            return safeUrl ? (
              <DescriptionListGroup>
                <DescriptionListTerm>URL</DescriptionListTerm>
                <DescriptionListDescription>
                  <a href={safeUrl} target="_blank" rel="noopener noreferrer">
                    {safeUrl}
                  </a>
                </DescriptionListDescription>
              </DescriptionListGroup>
            ) : null;
          })()}

          {packageDetails.repository && ["core", "extra", "multilib"].includes(packageDetails.repository) && (
            <DescriptionListGroup>
              <DescriptionListTerm>Package Source</DescriptionListTerm>
              <DescriptionListDescription>
                <a
                  href={`https://gitlab.archlinux.org/archlinux/packaging/packages/${encodeURIComponent(packageDetails.name)}`}
                  target="_blank"
                  rel="noopener noreferrer"
                >
                  View on Arch GitLab
                </a>
              </DescriptionListDescription>
            </DescriptionListGroup>
          )}

          {packageDetails.licenses.length > 0 && (
            <DescriptionListGroup>
              <DescriptionListTerm>Licenses</DescriptionListTerm>
              <DescriptionListDescription>
                <LabelGroup>
                  {packageDetails.licenses.map((license: string) => (
                    <Label key={license}>{license}</Label>
                  ))}
                </LabelGroup>
              </DescriptionListDescription>
            </DescriptionListGroup>
          )}

          {packageDetails.groups.length > 0 && (
            <DescriptionListGroup>
              <DescriptionListTerm>Groups</DescriptionListTerm>
              <DescriptionListDescription>
                <LabelGroup>
                  {packageDetails.groups.map((g: string) => (
                    <Label key={g} color="teal">{g}</Label>
                  ))}
                </LabelGroup>
              </DescriptionListDescription>
            </DescriptionListGroup>
          )}

          <DescriptionListGroup>
            <DescriptionListTerm>Architecture</DescriptionListTerm>
            <DescriptionListDescription>
              {packageDetails.architecture || "any"}
            </DescriptionListDescription>
          </DescriptionListGroup>

          {/* Size & Dates */}

          {!isInstalled && "download_size" in packageDetails && (
            <DescriptionListGroup>
              <DescriptionListTerm>Download Size</DescriptionListTerm>
              <DescriptionListDescription>
                {formatSize(packageDetails.download_size)}
              </DescriptionListDescription>
            </DescriptionListGroup>
          )}

          <DescriptionListGroup>
            <DescriptionListTerm>Installed Size</DescriptionListTerm>
            <DescriptionListDescription>
              {formatSize(packageDetails.installed_size)}
            </DescriptionListDescription>
          </DescriptionListGroup>

          <DescriptionListGroup>
            <DescriptionListTerm>Build Date</DescriptionListTerm>
            <DescriptionListDescription>
              {formatDate(packageDetails.build_date)}
            </DescriptionListDescription>
          </DescriptionListGroup>

          {isInstalled && (
            <>
              <DescriptionListGroup>
                <DescriptionListTerm>Install Date</DescriptionListTerm>
                <DescriptionListDescription>
                  {formatDate(packageDetails.install_date)}
                </DescriptionListDescription>
              </DescriptionListGroup>

              <DescriptionListGroup>
                <DescriptionListTerm>Install Reason</DescriptionListTerm>
                <DescriptionListDescription>
                  <Label color={packageDetails.reason === "explicit" ? "blue" : "grey"}>
                    {packageDetails.reason}
                  </Label>
                </DescriptionListDescription>
              </DescriptionListGroup>
            </>
          )}

          {/* Update History */}

          {isInstalled && packageDetails.update_stats && (
            <>
              <DescriptionListGroup>
                <DescriptionListTerm>Updates</DescriptionListTerm>
                <DescriptionListDescription>
                  {packageDetails.update_stats.update_count === 0
                    ? "Never updated"
                    : `${packageDetails.update_stats.update_count} update${packageDetails.update_stats.update_count !== 1 ? "s" : ""}`}
                  {packageDetails.update_stats.avg_days_between_updates !== null && (
                    <> (avg. every {packageDetails.update_stats.avg_days_between_updates.toFixed(0)} days)</>
                  )}
                </DescriptionListDescription>
              </DescriptionListGroup>

              {packageDetails.update_stats.first_installed && (
                <DescriptionListGroup>
                  <DescriptionListTerm>First Installed</DescriptionListTerm>
                  <DescriptionListDescription>
                    {new Date(packageDetails.update_stats.first_installed).toLocaleString()}
                  </DescriptionListDescription>
                </DescriptionListGroup>
              )}

              {packageDetails.update_stats.last_updated && (
                <DescriptionListGroup>
                  <DescriptionListTerm>Last Updated</DescriptionListTerm>
                  <DescriptionListDescription>
                    {new Date(packageDetails.update_stats.last_updated).toLocaleString()}
                  </DescriptionListDescription>
                </DescriptionListGroup>
              )}
            </>
          )}

          {/* Relationships */}

          {packageDetails.depends.length > 0 && (
            <DescriptionListGroup>
              <DescriptionListTerm>Dependencies</DescriptionListTerm>
              <DescriptionListDescription>
                <LabelGroup numLabels={10}>
                  {packageDetails.depends.map((dep: string) => (
                    <Label key={dep} variant="outline">{dep}</Label>
                  ))}
                </LabelGroup>
              </DescriptionListDescription>
            </DescriptionListGroup>
          )}

          {packageDetails.optdepends.length > 0 && (
            <DescriptionListGroup>
              <DescriptionListTerm>Optional Dependencies</DescriptionListTerm>
              <DescriptionListDescription>
                <LabelGroup numLabels={10}>
                  {packageDetails.optdepends.map((dep: string) => (
                    <Label key={dep} variant="outline" color="grey">{dep}</Label>
                  ))}
                </LabelGroup>
              </DescriptionListDescription>
            </DescriptionListGroup>
          )}

          {packageDetails.provides.length > 0 && (
            <DescriptionListGroup>
              <DescriptionListTerm>Provides</DescriptionListTerm>
              <DescriptionListDescription>
                <LabelGroup numLabels={10}>
                  {packageDetails.provides.map((p: string) => (
                    <Label key={p} variant="outline" color="green">{p}</Label>
                  ))}
                </LabelGroup>
              </DescriptionListDescription>
            </DescriptionListGroup>
          )}

          {packageDetails.conflicts.length > 0 && (
            <DescriptionListGroup>
              <DescriptionListTerm>Conflicts</DescriptionListTerm>
              <DescriptionListDescription>
                <LabelGroup numLabels={10}>
                  {packageDetails.conflicts.map((c: string) => (
                    <Label key={c} variant="outline" color="orange">{c}</Label>
                  ))}
                </LabelGroup>
              </DescriptionListDescription>
            </DescriptionListGroup>
          )}

          {packageDetails.replaces.length > 0 && (
            <DescriptionListGroup>
              <DescriptionListTerm>Replaces</DescriptionListTerm>
              <DescriptionListDescription>
                <LabelGroup numLabels={10}>
                  {packageDetails.replaces.map((r: string) => (
                    <Label key={r} variant="outline" color="orange">{r}</Label>
                  ))}
                </LabelGroup>
              </DescriptionListDescription>
            </DescriptionListGroup>
          )}

          {isInstalled && packageDetails.required_by.length > 0 && (
            <DescriptionListGroup>
              <DescriptionListTerm>Required By</DescriptionListTerm>
              <DescriptionListDescription>
                <LabelGroup numLabels={10}>
                  {packageDetails.required_by.map((r: string) => (
                    <Label key={r} variant="outline" color="purple">{r}</Label>
                  ))}
                </LabelGroup>
              </DescriptionListDescription>
            </DescriptionListGroup>
          )}

          {isInstalled && packageDetails.optional_for.length > 0 && (
            <DescriptionListGroup>
              <DescriptionListTerm>Optional For</DescriptionListTerm>
              <DescriptionListDescription>
                <LabelGroup numLabels={10}>
                  {packageDetails.optional_for.map((o: string) => (
                    <Label key={o} variant="outline" color="grey">{o}</Label>
                  ))}
                </LabelGroup>
              </DescriptionListDescription>
            </DescriptionListGroup>
          )}

          {/* Packaging */}

          {isInstalled && packageDetails.packager && (
            <DescriptionListGroup>
              <DescriptionListTerm>Packager</DescriptionListTerm>
              <DescriptionListDescription>
                {packageDetails.packager}
                {packageDetails.packager === "Unknown Packager" && (
                  <Popover
                    headerContent="Unknown Packager"
                    bodyContent={'This package was built locally without a PACKAGER configured in makepkg.conf. This is common for AUR packages. To set your packager identity, add PACKAGER="Your Name <email>" to ~/.makepkg.conf'}
                  >
                    <Icon isInline style={{ marginLeft: "0.5em", cursor: "pointer" }}>
                      <OutlinedQuestionCircleIcon />
                    </Icon>
                  </Popover>
                )}
              </DescriptionListDescription>
            </DescriptionListGroup>
          )}

          {isInstalled && packageDetails.validation.length > 0 && (
            <DescriptionListGroup>
              <DescriptionListTerm>Validation</DescriptionListTerm>
              <DescriptionListDescription>
                <LabelGroup>
                  {packageDetails.validation.map((v: string) => (
                    <Label key={v} variant="outline">{v}</Label>
                  ))}
                </LabelGroup>
              </DescriptionListDescription>
            </DescriptionListGroup>
          )}

          </DescriptionList>
        ) : null}
      </ModalBody>
      {packageDetails && (
        <ModalFooter>
          {onViewDependencies && (
            <Button
              variant="secondary"
              icon={<TopologyIcon />}
              onClick={() => {
                onViewDependencies(packageDetails.name);
                onClose();
              }}
            >
              View Dependencies
            </Button>
          )}
          {onViewHistory && (
            <Button
              variant="secondary"
              icon={<HistoryIcon />}
              onClick={() => {
                onViewHistory(packageDetails.name);
                onClose();
              }}
            >
              View History
            </Button>
          )}
          {isInstalled ? (
            <>
              <Button
                variant="secondary"
                icon={<ArrowDownIcon />}
                onClick={() => setDowngradeModalOpen(true)}
              >
                Downgrade
              </Button>
              <Button
                variant="danger"
                icon={<TrashIcon />}
                onClick={handleUninstall}
              >
                Uninstall
              </Button>
            </>
          ) : (
            <Button
              variant="primary"
              icon={<PlusCircleIcon />}
              onClick={handleInstall}
            >
              Install
            </Button>
          )}
        </ModalFooter>
      )}
    </Modal>
    {isInstalled && packageDetails && (
      <DowngradeModal
        packageName={packageDetails.name}
        currentVersion={packageDetails.version}
        isOpen={downgradeModalOpen}
        onClose={handleDowngradeClose}
      />
    )}
    {uninstallTarget && (
      <UninstallModal
        packageName={uninstallTarget.name}
        packageVersion={uninstallTarget.version}
        isOpen={true}
        onClose={handleUninstallClose}
        onSuccess={onPackageRemoved}
      />
    )}
    {installTarget && (
      <InstallModal
        packageName={installTarget.name}
        packageVersion={installTarget.version}
        isOpen={true}
        onClose={handleInstallClose}
        onSuccess={onPackageInstalled}
      />
    )}
    </>
  );
};
