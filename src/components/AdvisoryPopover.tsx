import React from "react";
import { Label, Popover } from "@patternfly/react-core";
import { ShieldAltIcon } from "@patternfly/react-icons";
import { PackageSecurityAdvisory } from "../api";
import { severityColor } from "../severity";
import { NO_FIX_CAVEAT, PartitionedAdvisories, highestOf } from "../security";

const subtleText: React.CSSProperties = {
  color: "var(--pf-t--global--text--color--subtle)",
  fontSize: "0.85em",
};

const AdvisoryLine: React.FC<{ advisory: PackageSecurityAdvisory }> = ({ advisory }) => (
  <div style={{ marginBottom: "0.5rem" }}>
    <a
      href={`https://security.archlinux.org/${advisory.avg_name}`}
      target="_blank"
      rel="noopener noreferrer"
    >
      {advisory.avg_name}
    </a>
    {" "}<Label isCompact color={severityColor(advisory.severity)}>{advisory.severity}</Label>
    <div style={subtleText}>
      {advisory.advisory_type}
      {advisory.cve_ids.length > 0 && ` (${advisory.cve_ids.join(", ")})`}
    </div>
    <div style={subtleText}>
      {advisory.fixed_version
        ? `fixed in ${advisory.fixed_version}, installed ${advisory.installed_version}`
        : `filed against ${advisory.affected_version}, installed ${advisory.installed_version}`}
    </div>
  </div>
);

export const AdvisoryPopover: React.FC<{ partition: PartitionedAdvisories }> = ({ partition }) => {
  const { actionable, unresolved } = partition;
  const total = actionable.length + unresolved.length;
  const highest = highestOf(actionable);
  return (
    <Popover
      headerContent={<>{total} securit{total === 1 ? "y advisory" : "y advisories"}</>}
      bodyContent={
        <div onClick={(e) => e.stopPropagation()}>
          {actionable.length > 0 && (
            <div style={{ marginBottom: "0.75rem" }}>
              <strong>Fixed by updating</strong>
              {actionable.map((a) => (
                <AdvisoryLine key={a.avg_name} advisory={a} />
              ))}
            </div>
          )}
          {unresolved.length > 0 && (
            <div>
              <strong>No fix recorded</strong>
              {unresolved.map((a) => (
                <AdvisoryLine key={a.avg_name} advisory={a} />
              ))}
              <div style={{ ...subtleText, marginTop: "0.25rem" }}>
                {NO_FIX_CAVEAT}
              </div>
            </div>
          )}
        </div>
      }
    >
      <Label
        isCompact
        color={highest ? severityColor(highest.severity) : "grey"}
        icon={<ShieldAltIcon />}
        className="pf-v6-u-ml-sm"
        style={{ cursor: "pointer" }}
        onClick={(e) => e.stopPropagation()}
      >
        {highest ? highest.severity : "No fix"}
        {total > 1 && ` +${total - 1}`}
      </Label>
    </Popover>
  );
};
