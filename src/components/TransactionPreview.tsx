import React, { useEffect, useRef, useState } from "react";
import {
  Alert,
  Content,
  ContentVariants,
  ExpandableSection,
  List,
  ListItem,
  Title,
} from "@patternfly/react-core";
import { Table, Thead, Tr, Th, Tbody, Td } from "@patternfly/react-table";
import {
  formatPreviewTotals,
  formatSize,
  type PreviewAdd,
  type PreviewRemove,
  type TransactionPreview as PreviewData,
} from "../api";
import { formatTotalsLine } from "../transactionTotals";
import { TransactionRisks, useRiskAcknowledgement, type Risks } from "./TransactionRisks";

const COLLAPSE_OVER = 10;

const plural = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;

/** One-line summary, e.g. "3 packages · Download size 12.4 MiB · Net size +48.1 MiB". */
export function previewSummary(preview: PreviewData): string {
  const totals = formatPreviewTotals(preview);
  return `${plural(totals.count, "package", "packages")} · ${formatTotalsLine(totals)}`;
}

const Group: React.FC<{ title: string; count: number; alwaysExpanded?: boolean; children: React.ReactNode }> = ({
  title, count, alwaysExpanded = false, children,
}) => {
  // Controlled so the toggle always carries aria-expanded; uncontrolled PF omits it while collapsed.
  const [expanded, setExpanded] = useState(false);
  if (count === 0) return null;
  if (count > COLLAPSE_OVER && !alwaysExpanded) {
    return (
      <ExpandableSection
        className="pf-v6-u-mt-md"
        toggleText={`${title} (${plural(count, "package", "packages")})`}
        isExpanded={expanded}
        onToggle={(_event, value) => setExpanded(value)}
      >
        {children}
      </ExpandableSection>
    );
  }
  return (
    <div className="pf-v6-u-mt-md">
      <Title headingLevel="h2" size="md">{`${title} (${count})`}</Title>
      {children}
    </div>
  );
};

const removeReasonText = (reason: PreviewRemove["reason"]) =>
  reason === "conflict" ? "Conflicts with a package being installed" : "Requested";

const addReasonText = (reason: PreviewAdd["reason"]) => (reason === "target" ? "Requested" : "Dependency");

export interface AcknowledgementState {
  complete: boolean;
  /** Labels of the ticks still unset. */
  missing: string[];
  /** Reason for an aria-disabled commit: blocks first, then unset ticks. */
  reason: string | undefined;
}

interface TransactionPreviewProps {
  preview: PreviewData;
  /** Title of the danger alert shown when the transaction cannot run, e.g. "Cannot uninstall foo". */
  failureTitle: string;
  /** Reports the risk ticks so the caller can gate its commit button. */
  onAcknowledgedChange?: (state: AcknowledgementState) => void;
  /** Closes the host dialog before a risk's action switches tabs. */
  beforeNavigate?: () => void;
}

/** Shows what a prepared, uncommitted transaction would install, upgrade and remove. */
export const TransactionPreview: React.FC<TransactionPreviewProps> = ({
  preview, failureTitle, onAcknowledgedChange, beforeNavigate,
}) => {
  const risks: Risks = {
    conflicts: preview.conflicts,
    replacements: preview.replacements,
    providers: preview.providers,
    importKeys: preview.import_keys,
    warnings: preview.warnings,
    removals: preview.remove.filter(p => p.reason === "conflict").map(p => p.name),
  };
  const acknowledgement = useRiskAcknowledgement(risks);
  const report = useRef(onAcknowledgedChange);
  useEffect(() => {
    report.current = onAcknowledgedChange;
  });
  const { complete, reason } = acknowledgement;
  const missingKey = acknowledgement.missing.join("\n");
  useEffect(() => {
    const missing = missingKey ? missingKey.split("\n") : [];
    report.current?.({ complete, missing, reason });
  }, [complete, missingKey, reason]);

  return (
    <>
      {!preview.success && (
        <Alert component="h2" variant="danger" isInline title={failureTitle} className="pf-v6-u-mb-md">
          {preview.blocked_by.length > 0 ? (
            <List>
              {preview.blocked_by.map(b => (
                <ListItem key={`${b.target}:${b.depend}`}>{`${b.target} requires ${b.depend}`}</ListItem>
              ))}
            </List>
          ) : (
            preview.error
          )}
        </Alert>
      )}

      {preview.success && (
        <Content component={ContentVariants.p}>
          <strong>{previewSummary(preview)}</strong>
        </Content>
      )}

      <TransactionRisks risks={risks} acknowledgement={acknowledgement} beforeNavigate={beforeNavigate} />

      <PreviewGroups add={preview.add} remove={preview.remove} />
    </>
  );
};

/**
 * The install, upgrade and removal tables of a preview; groups over 10 rows
 * start collapsed. Names in `pulledIn` get their own expanded group, first.
 */
export const PreviewGroups: React.FC<{ add: PreviewAdd[]; remove: PreviewRemove[]; pulledIn?: string[] }> = ({
  add, remove, pulledIn = [],
}) => {
  const byTargetFirst = (a: PreviewAdd, b: PreviewAdd) =>
    (a.reason === "target" ? 0 : 1) - (b.reason === "target" ? 0 : 1) || a.name.localeCompare(b.name);
  const beyond = new Set(pulledIn);
  const pulled = add.filter(p => beyond.has(p.name)).sort(byTargetFirst);
  const rest = add.filter(p => !beyond.has(p.name));
  const installs = rest.filter(p => !p.old_version).sort(byTargetFirst);
  const upgrades = rest.filter(p => p.old_version).sort(byTargetFirst);
  const removals = remove.filter(p => p.reason !== "dependency");
  const alsoRemoved = remove.filter(p => p.reason === "dependency");

  return (
    <>
      <Group title="Beyond your selection" count={pulled.length} alwaysExpanded>
        <Table aria-label="Beyond your selection" variant="compact">
          <Thead>
            <Tr>
              <Th>Package</Th>
              <Th>Version</Th>
              <Th>Reason</Th>
              <Th>Download</Th>
            </Tr>
          </Thead>
          <Tbody>
            {pulled.map(p => (
              <Tr key={p.name}>
                <Td dataLabel="Package">{p.name}</Td>
                <Td dataLabel="Version">{p.old_version ? `${p.old_version} → ${p.version}` : p.version}</Td>
                <Td dataLabel="Reason">{addReasonText(p.reason)}</Td>
                <Td dataLabel="Download">{formatSize(p.download_size)}</Td>
              </Tr>
            ))}
          </Tbody>
        </Table>
      </Group>

      <Group title="Will be installed" count={installs.length}>
        <Table aria-label="Will be installed" variant="compact">
          <Thead>
            <Tr>
              <Th>Package</Th>
              <Th>Version</Th>
              <Th>Reason</Th>
              <Th>Download</Th>
            </Tr>
          </Thead>
          <Tbody>
            {installs.map(p => (
              <Tr key={p.name}>
                <Td dataLabel="Package">{p.name}</Td>
                <Td dataLabel="Version">{p.version}</Td>
                <Td dataLabel="Reason">{addReasonText(p.reason)}</Td>
                <Td dataLabel="Download">{formatSize(p.download_size)}</Td>
              </Tr>
            ))}
          </Tbody>
        </Table>
      </Group>

      <Group title="Will be upgraded or reinstalled" count={upgrades.length}>
        <Table aria-label="Will be upgraded or reinstalled" variant="compact">
          <Thead>
            <Tr>
              <Th>Package</Th>
              <Th>Version</Th>
              <Th>Reason</Th>
              <Th>Download</Th>
            </Tr>
          </Thead>
          <Tbody>
            {upgrades.map(p => (
              <Tr key={p.name}>
                <Td dataLabel="Package">{p.name}</Td>
                <Td dataLabel="Version">{`${p.old_version} → ${p.version}`}</Td>
                <Td dataLabel="Reason">{addReasonText(p.reason)}</Td>
                <Td dataLabel="Download">{formatSize(p.download_size)}</Td>
              </Tr>
            ))}
          </Tbody>
        </Table>
      </Group>

      <Group title="Will be removed" count={removals.length}>
        <Table aria-label="Will be removed" variant="compact">
          <Thead>
            <Tr>
              <Th>Package</Th>
              <Th>Version</Th>
              <Th>Reason</Th>
              <Th>Size</Th>
            </Tr>
          </Thead>
          <Tbody>
            {removals.map(p => (
              <Tr key={p.name}>
                <Td dataLabel="Package">{p.name}</Td>
                <Td dataLabel="Version">{p.version}</Td>
                <Td dataLabel="Reason">{removeReasonText(p.reason)}</Td>
                <Td dataLabel="Size">{formatSize(p.installed_size)}</Td>
              </Tr>
            ))}
          </Tbody>
        </Table>
      </Group>

      <Group title="Also removed (no longer needed)" count={alsoRemoved.length}>
        <Table aria-label="Also removed (no longer needed)" variant="compact">
          <Thead>
            <Tr>
              <Th>Package</Th>
              <Th>Version</Th>
              <Th>Size</Th>
            </Tr>
          </Thead>
          <Tbody>
            {alsoRemoved.map(p => (
              <Tr key={p.name}>
                <Td dataLabel="Package">{p.name}</Td>
                <Td dataLabel="Version">{p.version}</Td>
                <Td dataLabel="Size">{formatSize(p.installed_size)}</Td>
              </Tr>
            ))}
          </Tbody>
        </Table>
      </Group>
    </>
  );
};
