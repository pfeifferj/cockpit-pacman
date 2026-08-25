import React from "react";
import {
  Card,
  CardBody,
  CardTitle,
  Flex,
  FlexItem,
  Checkbox,
  Tooltip,
} from "@patternfly/react-core";
import { UpdateInfo, KeyringStatusResponse, formatSize } from "../api";
import { StatBox } from "./StatBox";
import { useAdminPermission } from "../hooks/useAdminPermission";
import { useNavigation } from "../contexts/NavigationContext";

export const SystemOverviewCard: React.FC<{
  updates: UpdateInfo[];
  securityCount: number;
  securityLoading: boolean;
  securityUnavailable: boolean;
  orphanCount: number | null;
  cacheSize: number | null;
  keyringStatus: KeyringStatusResponse | null;
  summaryLoading: boolean;
  pendingSignoffs?: number | null;
  securityFilterActive?: boolean;
  onToggleSecurityFilter?: () => void;
  securityEnabled: boolean;
  onSetSecurityEnabled: (enabled: boolean) => void;
  securityToggleBusy: boolean;
}> = ({ updates, securityCount, securityLoading, securityUnavailable, orphanCount, cacheSize, keyringStatus, summaryLoading, pendingSignoffs, securityFilterActive, onToggleSecurityFilter, securityEnabled, onSetSecurityEnabled, securityToggleBusy }) => {
  const securityFilterable = securityEnabled && !!onToggleSecurityFilter && !securityLoading && !securityUnavailable && securityCount > 0;
  const { onViewOrphans, onViewCache, onViewKeyring, onViewSignoffs } = useNavigation();
  const isAdmin = useAdminPermission();
  const mayToggle = isAdmin === true && !securityToggleBusy;
  return (
  <Card className="pf-v6-u-mb-md">
    <CardBody>
      <CardTitle className="pf-v6-u-m-0 pf-v6-u-mb-md">System Overview</CardTitle>
      <Flex spaceItems={{ default: "spaceItemsLg" }}>
        <FlexItem>
          <StatBox
            label="Updates"
            value={(updates.length).toLocaleString()}
            color={updates.length > 0 ? "danger" : "success"}
          />
        </FlexItem>
        <FlexItem>
          <Flex direction={{ default: "column" }} spaceItems={{ default: "spaceItemsXs" }}>
            <FlexItem>
          <StatBox
            label={securityFilterActive ? "Show all" : "Security"}
            value={
              securityFilterActive
                ? (updates.length).toLocaleString()
                : securityLoading || securityUnavailable || !securityEnabled
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
            <FlexItem>
              <Tooltip
                content={
                  isAdmin === false
                    ? "Not permitted to change system settings"
                    : "Stop checking the Arch Security Tracker. Its records can stay open long after a fix ships."
                }
              >
                <div>
                  <Checkbox
                    id="security-advisories-enabled"
                    label="Check advisories"
                    isChecked={securityEnabled}
                    isDisabled={!mayToggle}
                    onChange={(_e, checked) => onSetSecurityEnabled(checked)}
                  />
                </div>
              </Tooltip>
            </FlexItem>
          </Flex>
        </FlexItem>
        <FlexItem>
          <Tooltip content="Packages installed as dependencies that are no longer required by any other package. Usually safe to remove.">
            <div>
              <StatBox
                label="Orphans"
                value={orphanCount !== null ? (orphanCount).toLocaleString() : "-"}
                color={orphanCount && orphanCount > 0 ? "warning" : "default"}
                isLoading={summaryLoading}
                onClick={onViewOrphans}
                ariaLabel="View orphaned packages"
              />
            </div>
          </Tooltip>
        </FlexItem>
        <FlexItem>
          <StatBox
            label="Cache"
            value={cacheSize !== null ? formatSize(cacheSize) : "-"}
            isLoading={summaryLoading}
            onClick={onViewCache}
            ariaLabel="View package cache"
          />
        </FlexItem>
        <FlexItem>
          <StatBox
            label="Keyring"
            value={keyringStatus ? `${keyringStatus.total} keys` : "-"}
            color={keyringStatus?.warnings.length ? "warning" : "default"}
            isLoading={summaryLoading}
            onClick={onViewKeyring}
            ariaLabel="View keyring"
          />
        </FlexItem>
        {pendingSignoffs != null && onViewSignoffs && (
          <FlexItem>
            <Tooltip content="Packages in [testing] repositories waiting for Trusted User signoffs before moving to stable.">
              <div>
                <StatBox
                  label="Signoffs"
                  value={(pendingSignoffs).toLocaleString()}
                  color={pendingSignoffs > 0 ? "info" : "default"}
                  onClick={onViewSignoffs}
                  ariaLabel="View package signoffs"
                />
              </div>
            </Tooltip>
          </FlexItem>
        )}
      </Flex>
    </CardBody>
  </Card>
  );
};
