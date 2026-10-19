import React, { useState } from "react";
import {
  Alert,
  AlertActionLink,
  Card,
  CardBody,
  Dropdown,
  DropdownItem,
  DropdownList,
  Flex,
  FlexItem,
} from "@patternfly/react-core";
import { UpdateInfo, KeyringStatusResponse, formatSize } from "../api";
import { StatBox } from "./StatBox";
import { kebabToggle } from "./KebabToggle";
import { useAdminPermission } from "../hooks/useAdminPermission";
import { useNavigation } from "../contexts/NavigationContext";
import { SIGNOFF_TILE_FILTER } from "./SignoffsView";
import { plural } from "../utils";

const drillName = (subject: string, action: string) => `${subject}, ${action}`;

export const SystemOverviewCard: React.FC<{
  updates: UpdateInfo[];
  securityCount: number;
  securityLoading: boolean;
  securityUnavailable: boolean;
  orphanCount: number | null;
  cacheSize: number | null;
  keyringStatus: KeyringStatusResponse | null;
  summaryLoading: boolean;
  /** Installed, pending packages not yet signed off by the stored ArchWeb user. */
  pendingSignoffs?: number | null;
  securityFilterActive?: boolean;
  onToggleSecurityFilter?: () => void;
  securityEnabled: boolean | null;
  onSetSecurityEnabled: (enabled: boolean) => void;
  securityToggleBusy: boolean;
  /** Why the last advisory toggle failed; `securityEnabled` is the state it was left in. */
  securityToggleError?: string | null;
}> = ({ updates, securityCount, securityLoading, securityUnavailable, orphanCount, cacheSize, keyringStatus, summaryLoading, pendingSignoffs, securityFilterActive, onToggleSecurityFilter, securityEnabled, onSetSecurityEnabled, securityToggleBusy, securityToggleError }) => {
  const securityFilterable = securityEnabled && !!onToggleSecurityFilter && !securityLoading && !securityUnavailable && securityCount > 0;
  const { onViewOrphans, onViewCache, onViewKeyring, onViewSignoffs } = useNavigation();
  const isAdmin = useAdminPermission();
  const mayToggle = isAdmin === true && !securityToggleBusy && securityEnabled !== null;
  const [menuOpen, setMenuOpen] = useState(false);
  const settingsMenu = (
    <Dropdown
      isOpen={menuOpen}
      onOpenChange={setMenuOpen}
      popperProps={{ position: "right" }}
      toggle={kebabToggle("Overview settings", menuOpen, () => setMenuOpen(!menuOpen))}
    >
      <DropdownList>
        <DropdownItem
          hasCheckbox={securityEnabled !== null}
          isSelected={securityEnabled === true}
          isDisabled={!mayToggle}
          isAriaDisabled={!mayToggle}
          description={
            securityEnabled === null ? "Saved advisory setting is unavailable" : isAdmin === false
              ? "Not permitted to change system settings"
              : "Queries the Arch Security Tracker for installed packages"
          }
          onClick={() => { if (mayToggle) onSetSecurityEnabled(!securityEnabled); }}
        >
          Check security advisories
        </DropdownItem>
      </DropdownList>
    </Dropdown>
  );
  return (
  <Card component="section" aria-label="System overview" className="pf-v6-u-mb-md">
    <CardBody>
      {securityToggleError && (
        <Alert
          variant="danger"
          isInline
          isPlain
          className="pf-v6-u-mb-md"
          title={`Could not turn security advisory checks ${securityEnabled ? "off" : "on"}. They are still ${securityEnabled ? "on" : "off"}.`}
          actionLinks={
            <AlertActionLink isDisabled={!mayToggle} onClick={() => onSetSecurityEnabled(!securityEnabled)}>
              Try again
            </AlertActionLink>
          }
        >
          {securityToggleError}
        </Alert>
      )}
      <Flex spaceItems={{ default: "spaceItemsLg" }}>
        <FlexItem>
          <StatBox
            label="Updates"
            value={(updates.length).toLocaleString()}
            color={updates.length > 0 ? "danger" : "success"}
          />
        </FlexItem>
        {securityEnabled && (
          <FlexItem>
            <StatBox
              label={securityFilterActive ? "Show all" : "Security"}
              value={
                securityFilterActive
                  ? (updates.length).toLocaleString()
                  : securityLoading || securityUnavailable
                    ? "-"
                    : (securityCount).toLocaleString()
              }
              color={!securityFilterActive && !securityUnavailable && securityCount > 0 ? "danger" : "default"}
              isLoading={securityLoading}
              onClick={securityFilterable ? onToggleSecurityFilter : undefined}
              isActive={securityFilterable ? securityFilterActive : undefined}
              ariaLabel={securityFilterActive ? "Show all updates" : "Filter to security updates"}
            />
          </FlexItem>
        )}
        <FlexItem>
          <StatBox
            label="Orphans"
            value={orphanCount !== null ? (orphanCount).toLocaleString() : "-"}
            color={orphanCount && orphanCount > 0 ? "warning" : "default"}
            isLoading={summaryLoading}
            onClick={onViewOrphans}
            ariaLabel={drillName(orphanCount !== null && !summaryLoading ? plural(orphanCount, "orphan") : "Orphans", "view orphaned packages")}
            description="Packages installed as dependencies that are no longer required by any other package. Usually safe to remove."
          />
        </FlexItem>
        <FlexItem>
          <StatBox
            label="Cache"
            value={cacheSize !== null ? formatSize(cacheSize) : "-"}
            isLoading={summaryLoading}
            onClick={onViewCache}
            ariaLabel={drillName(cacheSize !== null && !summaryLoading ? `${formatSize(cacheSize)} in package cache` : "Package cache", "view package cache")}
          />
        </FlexItem>
        <FlexItem>
          <StatBox
            label="Keyring"
            value={keyringStatus ? plural(keyringStatus.total, "key") : "-"}
            color={keyringStatus?.warnings.length ? "warning" : "default"}
            isLoading={summaryLoading}
            onClick={onViewKeyring}
            ariaLabel={drillName(keyringStatus && !summaryLoading ? `${plural(keyringStatus.total, "key")} in keyring` : "Keyring", "view keyring")}
          />
        </FlexItem>
        {pendingSignoffs != null && onViewSignoffs && (
          <FlexItem>
            <StatBox
              label="To sign off"
              value={(pendingSignoffs).toLocaleString()}
              color={pendingSignoffs > 0 ? "info" : "default"}
              onClick={() => onViewSignoffs(SIGNOFF_TILE_FILTER)}
              ariaLabel={drillName(`${plural(pendingSignoffs, "package")} to sign off`, "view package signoffs")}
              description="Installed packages from [testing] repositories that are still pending and that you have not signed off. Package maintainers sign off tested packages before they move to stable."
            />
          </FlexItem>
        )}
        <FlexItem align={{ default: "alignRight" }}>
          {settingsMenu}
        </FlexItem>
      </Flex>
    </CardBody>
  </Card>
  );
};
