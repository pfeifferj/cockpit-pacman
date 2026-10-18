import React, { useCallback, useEffect, useRef, useState, useMemo, useId } from "react";
import {
  Alert,
  Button,
  ClipboardCopyButton,
  CodeBlock,
  CodeBlockAction,
  CodeBlockCode,
  Content,
  ContentVariants,
  ExpandableSection,
  Modal,
  ModalVariant,
  ModalHeader,
  ModalBody,
  ModalFooter,
} from "@patternfly/react-core";
import { PreflightResponse, UpdateInfo, formatSize, onSystemChanged } from "../api";
import { useBackdropClose } from "../hooks/useBackdropClose";
import { useAnnounce } from "../contexts/AnnouncerContext";
import { plural } from "../utils";
import {
  beyondSelection,
  describeUpgrade,
  formatTotalsLine,
  listNames,
  removalNames,
  upgradeCounts,
  upgradePreviewTotals,
} from "../transactionTotals";
import { GatedButton } from "./GatedButton";
import { PreviewGroups } from "./TransactionPreview";
import { TransactionRisks, useRiskAcknowledgement, type Risks } from "./TransactionRisks";

/** Commit gate reason while a preview no longer describes the system. */
export const PREVIEW_STALE_REASON = "The system changed since this preview";

export interface PreviewStaleness {
  /** When the change arrived, or null while the preview is current. */
  staleAt: Date | null;
  reset: (stale?: boolean) => void;
}

/**
 * Marks an open preview stale when a transaction or database sync ends while
 * `watching` is true. Callers stop watching once their own commit starts, so
 * the end of that run does not count.
 */
export function usePreviewStaleness(watching: boolean, initiallyStale = false): PreviewStaleness {
  const [staleAt, setStaleAt] = useState<Date | null>(() => (initiallyStale ? new Date() : null));
  const staleRef = useRef(staleAt !== null);
  const announce = useAnnounce();
  useEffect(() => {
    if (!watching) return;
    return onSystemChanged(() => {
      if (staleRef.current) return;
      staleRef.current = true;
      setStaleAt(new Date());
      announce(PREVIEW_STALE_REASON);
    }, ["system", "sync"]);
  }, [watching, announce]);
  const reset = useCallback((stale = false) => {
    staleRef.current = stale;
    setStaleAt(stale ? new Date() : null);
  }, []);
  return { staleAt, reset };
}

export const PreviewStaleAlert: React.FC<{ staleAt: Date | null; className?: string }> = ({ staleAt, className }) =>
  staleAt ? (
    <Alert component="h2" variant="warning" isInline title={PREVIEW_STALE_REASON} className={className}>
      {`Packages were installed, removed or synced at ${staleAt.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}. Refresh the preview before you continue.`}
    </Alert>
  ) : null;

type PendingPackage = Pick<UpdateInfo, "name" | "current_version" | "new_version">;

interface Props {
  isOpen: boolean;
  preflight: PreflightResponse | null;
  packages?: PendingPackage[];
  /** Deselected, non-held updates this run leaves out. */
  skipped?: string[];
  onClose: () => void;
  onProceed: () => void;
  /** Reruns the preflight in place; offered when the preview is stale or blocked. */
  onRefresh?: () => void;
  /** A refresh started by onRefresh is running. */
  refreshing?: boolean;
  /** The system changed while the preflight ran, before the dialog opened. */
  initiallyStale?: boolean;
}

const INLINE_NAMES = 5;

function transactionText(packages: PendingPackage[], preflight: PreflightResponse | null): string {
  const selected = new Set(packages.map((p) => p.name));
  return [
    ...packages.map((p) => `${p.name} ${p.current_version} -> ${p.new_version}`),
    ...(preflight?.add ?? [])
      .filter((p) => !selected.has(p.name))
      .map((p) => (p.old_version ? `${p.name} ${p.old_version} -> ${p.version}` : `install ${p.name} ${p.version}`)),
    ...removalNames(preflight).map((name) => `remove ${name}`),
    ...(preflight?.replacements ?? []).map((r) => `replace ${r.old_package} with ${r.new_package}`),
  ].join("\n");
}

const named = (names: string[], noun: [string, string]) =>
  names.length <= INLINE_NAMES ? listNames(names) : plural(names.length, ...noun);

const ConfirmBody: React.FC<Omit<Props, "isOpen">> = ({
  preflight, packages = [], skipped = [], onClose, onProceed, onRefresh, refreshing = false, initiallyStale = false,
}) => {
  const titleId = useId();
  const [copyExpanded, setCopyExpanded] = useState(false);
  const [copied, setCopied] = useState(false);
  const copyText = useMemo(() => transactionText(packages, preflight), [packages, preflight]);

  const removals = useMemo(() => removalNames(preflight), [preflight]);
  const risks: Risks = {
    conflicts: preflight?.conflicts ?? [],
    replacements: preflight?.replacements ?? [],
    providers: preflight?.providers ?? [],
    importKeys: preflight?.import_keys ?? [],
    warnings: preflight?.warnings ?? [],
    removals,
  };
  const acknowledgement = useRiskAcknowledgement(risks);
  useBackdropClose(true, acknowledgement.started ? undefined : onClose);
  const staleness = usePreviewStaleness(!refreshing, initiallyStale);
  const { reset: resetStale } = staleness;
  const [shownPreflight, setShownPreflight] = useState(preflight);
  if (preflight !== shownPreflight) {
    setShownPreflight(preflight);
    resetStale(initiallyStale);
    acknowledgement.reset();
  }
  const stale = staleness.staleAt !== null;
  const commitReason = refreshing ? "Refreshing the preview…" : stale ? PREVIEW_STALE_REASON : acknowledgement.reason;

  const label = describeUpgrade(preflight ? upgradeCounts(preflight) : { upgrade: 0, install: 0, remove: 0 });
  const totals = preflight ? upgradePreviewTotals(preflight) : null;
  const beyond = preflight?.add && packages.length > 0
    ? beyondSelection(preflight, packages.map((p) => p.name))
    : null;
  const pulledInNames = beyond?.add.map((p) => p.name) ?? [];
  const beyondParts = beyond
    ? [
      ...(pulledInNames.length > 0
        ? [`${named(pulledInNames, ["package", "packages"])} pulled in (${formatSize(beyond.downloadBytes)} download)`
          + (pulledInNames.length > INLINE_NAMES ? ", listed first below" : "")]
        : []),
      ...(beyond.removeNames.length > 0
        ? [`${named(beyond.removeNames, ["package", "packages"])} removed`
          + (beyond.freedBytes > 0 ? ` (${formatSize(beyond.freedBytes)} freed)` : "")]
        : []),
    ]
    : [];

  return (
    <Modal
      variant={ModalVariant.medium}
      isOpen
      onClose={onClose}
      aria-labelledby={titleId}
    >
      <ModalHeader title={`${label}?`} labelId={titleId} />
      <ModalBody>
        <PreviewStaleAlert staleAt={staleness.staleAt} className="pf-v6-u-mb-md" />
        {preflight && (
          <Content>
            <Content component={ContentVariants.p}>
              {totals
                ? formatTotalsLine(totals)
                : `Download size ${formatSize(preflight.total_download_size)}`}
            </Content>
            {beyondParts.length > 0 && (
              <Content component={ContentVariants.p}>
                <strong>Beyond your selection:</strong> {beyondParts.join(" and ")}
              </Content>
            )}

            {skipped.length > 0 && (
              <Alert component="h2" variant="warning" title="Partial upgrade" isInline className="pf-v6-u-mt-md">
                {`Skipping ${skipped.join(", ")}. Partial upgrades are unsupported and may cause dependency issues.`}
              </Alert>
            )}

            <TransactionRisks risks={risks} acknowledgement={acknowledgement} beforeNavigate={onClose} />

            {preflight.add && (
              <PreviewGroups
                add={preflight.add}
                remove={preflight.remove ?? []}
                pulledIn={pulledInNames.length > INLINE_NAMES ? pulledInNames : undefined}
              />
            )}

            {copyText && (
              <ExpandableSection
                toggleText="Copy as text"
                isExpanded={copyExpanded}
                onToggle={(_event, expanded) => setCopyExpanded(expanded)}
                className="pf-v6-u-mt-md"
              >
                <CodeBlock
                  actions={
                    <CodeBlockAction>
                      <ClipboardCopyButton
                        id="preflight-transaction-copy"
                        aria-label="Copy transaction"
                        onClick={() => {
                          window.navigator.clipboard?.writeText(copyText).then(() => setCopied(true), () => setCopied(false));
                        }}
                        exitDelay={copied ? 1500 : 600}
                        variant="plain"
                        onTooltipHidden={() => setCopied(false)}
                      >
                        {copied ? "Copied" : "Copy transaction"}
                      </ClipboardCopyButton>
                    </CodeBlockAction>
                  }
                >
                  <CodeBlockCode id="preflight-transaction-code">{copyText}</CodeBlockCode>
                </CodeBlock>
              </ExpandableSection>
            )}
          </Content>
        )}
      </ModalBody>
      <ModalFooter>
        <GatedButton
          key="confirm"
          variant={removals.length > 0 || risks.conflicts.length > 0 ? "danger" : "primary"}
          onClick={onProceed}
          disabledReason={commitReason}
        >
          {label}
        </GatedButton>
        {onRefresh && (stale || acknowledgement.blocked.length > 0) && (
          <Button key="refresh" variant="secondary" onClick={onRefresh} isLoading={refreshing} isAriaDisabled={refreshing}>
            {stale ? "Refresh preview" : "Check again"}
          </Button>
        )}
        <Button key="cancel" variant="link" onClick={onClose}>
          Cancel
        </Button>
      </ModalFooter>
    </Modal>
  );
};

// Unmounting between opens is what resets the acknowledgement state; do not
// flatten this into a hidden-but-mounted modal.
export const PreflightConfirmModal: React.FC<Props> = ({ isOpen, ...rest }) =>
  isOpen ? <ConfirmBody {...rest} /> : null;
