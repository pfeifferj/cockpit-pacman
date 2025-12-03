import React from "react";
import {
  Modal,
  ModalVariant,
  Spinner,
  DescriptionList,
  DescriptionListGroup,
  DescriptionListTerm,
  DescriptionListDescription,
  Label,
  LabelGroup,
  Popover,
  Icon,
} from "@patternfly/react-core";
import { OutlinedQuestionCircleIcon } from "@patternfly/react-icons";
import { PackageDetails, SyncPackageDetails, formatSize, formatDate } from "../api";

type PackageInfo = PackageDetails | SyncPackageDetails;

function isInstalledPackage(pkg: PackageInfo): pkg is PackageDetails {
  return "install_date" in pkg && "reason" in pkg && "validation" in pkg;
}

interface PackageDetailsModalProps {
  packageDetails: PackageInfo | null;
  isLoading: boolean;
  onClose: () => void;
}

export const PackageDetailsModal: React.FC<PackageDetailsModalProps> = ({
  packageDetails,
  isLoading,
  onClose,
}) => {
  const isOpen = packageDetails !== null || isLoading;
  const isInstalled = packageDetails && isInstalledPackage(packageDetails);

  return (
    <Modal
      variant={ModalVariant.medium}
      title={packageDetails?.name ?? "Package Details"}
      isOpen={isOpen}
      onClose={onClose}
    >
      {isLoading ? (
        <Spinner />
      ) : packageDetails ? (
        <DescriptionList>
          <DescriptionListGroup>
            <DescriptionListTerm>Version</DescriptionListTerm>
            <DescriptionListDescription>
              {packageDetails.version}
            </DescriptionListDescription>
          </DescriptionListGroup>

          <DescriptionListGroup>
            <DescriptionListTerm>Repository</DescriptionListTerm>
            <DescriptionListDescription>
              {packageDetails.repository || "local"}
              {isInstalled && !packageDetails.repository && (
                <Popover
                  headerContent="Local Package"
                  bodyContent="This package is not from an official repository. It may have been installed from the AUR, built manually with makepkg, or installed from a local PKGBUILD."
                >
                  <Icon isInline style={{ marginLeft: "0.5em", cursor: "pointer" }}>
                    <OutlinedQuestionCircleIcon />
                  </Icon>
                </Popover>
              )}
            </DescriptionListDescription>
          </DescriptionListGroup>

          <DescriptionListGroup>
            <DescriptionListTerm>Description</DescriptionListTerm>
            <DescriptionListDescription>
              {packageDetails.description || "-"}
            </DescriptionListDescription>
          </DescriptionListGroup>

          {packageDetails.url && (
            <DescriptionListGroup>
              <DescriptionListTerm>URL</DescriptionListTerm>
              <DescriptionListDescription>
                <a href={packageDetails.url} target="_blank" rel="noopener noreferrer">
                  {packageDetails.url}
                </a>
              </DescriptionListDescription>
            </DescriptionListGroup>
          )}

          {packageDetails.repository && ["core", "extra", "multilib"].includes(packageDetails.repository) && (
            <DescriptionListGroup>
              <DescriptionListTerm>Package Source</DescriptionListTerm>
              <DescriptionListDescription>
                <a
                  href={`https://gitlab.archlinux.org/archlinux/packaging/packages/${packageDetails.name}`}
                  target="_blank"
                  rel="noopener noreferrer"
                >
                  View on Arch GitLab
                </a>
              </DescriptionListDescription>
            </DescriptionListGroup>
          )}

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

          <DescriptionListGroup>
            <DescriptionListTerm>Architecture</DescriptionListTerm>
            <DescriptionListDescription>
              {packageDetails.architecture || "any"}
            </DescriptionListDescription>
          </DescriptionListGroup>

          <DescriptionListGroup>
            <DescriptionListTerm>Build Date</DescriptionListTerm>
            <DescriptionListDescription>
              {formatDate(packageDetails.build_date)}
            </DescriptionListDescription>
          </DescriptionListGroup>
        </DescriptionList>
      ) : null}
    </Modal>
  );
};
