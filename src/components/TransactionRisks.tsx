import React, { useId, useState } from "react";
import { Alert, AlertActionLink, Checkbox, Content, ContentVariants, List, ListItem } from "@patternfly/react-core";
import type {
  ConflictInfo,
  DiskSpaceShortfall,
  PreflightKeyInfo,
  PreflightWarning,
  ProviderChoice,
  ReplacementInfo,
} from "../api";
import { listNames } from "../transactionTotals";
import { useNavigation } from "../contexts/NavigationContext";

export interface Risks {
  conflicts: ConflictInfo[];
  replacements: ReplacementInfo[];
  providers: ProviderChoice[];
  importKeys: PreflightKeyInfo[];
  warnings: PreflightWarning[];
  /** Packages the transaction removes that were not asked for. */
  removals: string[];
}

interface Acknowledgement {
  id: string;
  label: string;
}

// A conflict alpm resolves by removing one side is already covered by the removal tick.
function conflictsFoldIntoRemovals(risks: Risks): boolean {
  return (
    risks.conflicts.length > 0 &&
    risks.conflicts.every((c) => risks.removals.includes(c.package1) || risks.removals.includes(c.package2))
  );
}

const KIB = 1024;
const MIB = 1024 * KIB;
const GIB = 1024 * MIB;

/** Bytes rounded up at display precision, so "at least" never understates. */
export function formatAtLeast(bytes: number): string {
  const up = (value: number, digits: number) => (Math.ceil(value * 10 ** digits) / 10 ** digits).toFixed(digits);
  if (bytes >= GIB) return `${up(bytes / GIB, 2)} GiB`;
  if (bytes >= MIB) return `${up(bytes / MIB, 1)} MiB`;
  if (bytes >= KIB) return `${up(bytes / KIB, 1)} KiB`;
  return `${Math.max(0, Math.ceil(bytes))} B`;
}

/** "Free at least 1.20 GiB on /usr." */
export function freeAtLeast(disk: DiskSpaceShortfall): string {
  return `Free at least ${formatAtLeast(disk.deficit)} on ${disk.mount}.`;
}

/** Whether cleaning the package cache helps on the short filesystem. */
export function cacheHint(disk: DiskSpaceShortfall): string {
  return disk.holds_cache
    ? `Cleaning the package cache frees space on ${disk.mount}.`
    : `The package cache is on another filesystem, so cleaning it does not free space on ${disk.mount}.`;
}

const isBlock = (w: PreflightWarning) => w.blocking;

const needsTick = (w: PreflightWarning) => !isBlock(w) && (w.severity === "warning" || w.severity === "danger");

/** One reason per blocking warning, e.g. "Not enough free space on /usr. Free at least 1.20 GiB on /usr. …". */
export function blockingReasons(risks: Risks): string[] {
  return [
    ...(risks.importKeys.length > 0 ? ["Verify and import the signing keys before retrying."] : []),
    ...risks.warnings.filter(isBlock).map((w) =>
      w.disk ? `${w.title}. ${freeAtLeast(w.disk)} ${cacheHint(w.disk)}` : `${w.title}.`
    ),
  ];
}

export function requiredAcknowledgements(risks: Risks): Acknowledgement[] {
  const acks: Acknowledgement[] = [];
  if (risks.removals.length > 0) {
    acks.push({ id: "removals", label: `Remove ${listNames(risks.removals)}` });
  }
  if (risks.conflicts.length > 0 && !conflictsFoldIntoRemovals(risks)) {
    const pairs = risks.conflicts.map((c) => `${c.package1} with ${c.package2}`);
    acks.push({ id: "conflicts", label: `Resolve ${risks.conflicts.length === 1 ? "the conflict" : "conflicts"} of ${listNames(pairs)}` });
  }
  for (const w of risks.warnings.filter(needsTick)) {
    acks.push({ id: `warning:${w.id}`, label: `Proceed despite: ${w.title}` });
  }
  return acks;
}

export interface RiskAcknowledgement {
  acked: ReadonlySet<string>;
  toggle: (id: string, checked: boolean) => void;
  reset: () => void;
  /** Nothing blocks and every required tick is set. */
  complete: boolean;
  /** Reasons the transaction cannot run at all; no tick clears them. */
  blocked: string[];
  /** Labels of the ticks still unset. */
  missing: string[];
  /** At least one tick is set. */
  started: boolean;
  /** Reason for an aria-disabled commit: blocks first, then unset ticks. */
  reason: string | undefined;
}

export function useRiskAcknowledgement(risks: Risks): RiskAcknowledgement {
  const [acked, setAcked] = useState<ReadonlySet<string>>(new Set());
  const missing = requiredAcknowledgements(risks).filter((a) => !acked.has(a.id)).map((a) => a.label);
  const blocked = blockingReasons(risks);
  return {
    acked,
    reset: () => setAcked(new Set()),
    toggle: (id, checked) =>
      setAcked((prev) => {
        const next = new Set(prev);
        if (checked) next.add(id);
        else next.delete(id);
        return next;
      }),
    complete: blocked.length === 0 && missing.length === 0,
    blocked,
    missing,
    started: acked.size > 0,
    reason: acknowledgementReason(missing, blocked),
  };
}

/** Reason for an aria-disabled commit button: each block, then each unset tick. */
export function acknowledgementReason(missing: string[], blocked: string[] = []): string | undefined {
  const parts = [...blocked, ...(missing.length > 0 ? [`Confirm first: ${missing.join("; ")}`] : [])];
  return parts.length > 0 ? parts.join(" ") : undefined;
}

interface TransactionRisksProps {
  risks: Risks;
  acknowledgement: RiskAcknowledgement;
  /** Closes the host dialog before a block's action switches tabs. */
  beforeNavigate?: () => void;
}

/** Transaction risks and required acknowledgements. */
export const TransactionRisks: React.FC<TransactionRisksProps> = ({ risks, acknowledgement, beforeNavigate }) => {
  const idPrefix = useId();
  const { onViewCache } = useNavigation();
  const folded = conflictsFoldIntoRemovals(risks);
  const byId = new Map(requiredAcknowledgements(risks).map((a) => [a.id, a.label]));

  const tick = (id: string) => {
    const label = byId.get(id);
    if (!label) return null;
    return (
      <Checkbox
        id={`${idPrefix}-${id}`}
        label={label}
        isChecked={acknowledgement.acked.has(id)}
        onChange={(_event, checked) => acknowledgement.toggle(id, checked)}
        className="pf-v6-u-mt-sm"
      />
    );
  };

  return (
    <>
      {risks.removals.length > 0 && (
        <Alert component="h2" variant="danger" title="Packages will be removed" isInline className="pf-v6-u-mt-md">
          <Content component={ContentVariants.p}>
            {folded
              ? "These packages are removed to resolve the conflicts below:"
              : "These packages will be removed:"}
          </Content>
          <List>
            {risks.removals.map((pkg) => <ListItem key={pkg}>{pkg}</ListItem>)}
          </List>
          {tick("removals")}
        </Alert>
      )}

      {risks.conflicts.length > 0 && (
        <Alert component="h2" variant="warning" title="Package conflicts" isInline className="pf-v6-u-mt-md">
          <Content component={ContentVariants.p}>
            {folded
              ? "Each conflict is resolved by removing a package listed above:"
              : "These conflicts are resolved automatically:"}
          </Content>
          <List>
            {risks.conflicts.map((c) => (
              <ListItem key={`${c.package1}:${c.package2}`}>{`${c.package1} conflicts with ${c.package2}`}</ListItem>
            ))}
          </List>
          {tick("conflicts")}
        </Alert>
      )}

      {risks.importKeys.length > 0 && (
        <Alert component="h2" variant="warning" title="Signing keys require verification" isInline className="pf-v6-u-mt-md">
          <Content component={ContentVariants.p}>
            Verify these fingerprints and import the keys with pacman-key before retrying. This page does not import signing keys automatically.
          </Content>
          <List>
            {risks.importKeys.map((k) => (
              <ListItem key={k.fingerprint}>{`${k.uid} (${k.fingerprint})`}</ListItem>
            ))}
          </List>
        </Alert>
      )}

      {risks.warnings.map((w) => (
        <Alert component="h2"
          key={w.id}
          variant={w.severity}
          title={w.title}
          isInline
          className="pf-v6-u-mt-md"
          actionLinks={w.disk?.holds_cache && onViewCache && (
            <AlertActionLink
              onClick={() => {
                beforeNavigate?.();
                onViewCache();
              }}
            >
              Open Cache
            </AlertActionLink>
          )}
        >
          <Content component={ContentVariants.p}>{w.message}</Content>
          {w.disk && (
            <Content component={ContentVariants.p}>
              {isBlock(w) ? `${freeAtLeast(w.disk)} ${cacheHint(w.disk)}` : cacheHint(w.disk)}
            </Content>
          )}
          {w.packages.length > 0 && (
            <List>
              {w.packages.map((pkg) => <ListItem key={`${w.id}-${pkg}`}>{pkg}</ListItem>)}
            </List>
          )}
          {tick(`warning:${w.id}`)}
        </Alert>
      ))}

      {risks.replacements.length > 0 && (
        <Alert component="h2" variant="info" title="Package replacements" isInline className="pf-v6-u-mt-md">
          <List>
            {risks.replacements.map((r) => (
              <ListItem key={`${r.old_package}:${r.new_package}`}>{`${r.new_package} replaces ${r.old_package}`}</ListItem>
            ))}
          </List>
        </Alert>
      )}

      {risks.providers.length > 0 && (
        <Alert component="h2" variant="info" title="Provider choices" isInline className="pf-v6-u-mt-md">
          <List>
            {risks.providers.map((p) => (
              <ListItem key={p.dependency}>
                {`${p.dependency}: ${p.providers[0] ?? ""}`}
                {p.providers.length > 1 && ` (also provided by ${p.providers.slice(1).join(", ")})`}
              </ListItem>
            ))}
          </List>
        </Alert>
      )}
    </>
  );
};
