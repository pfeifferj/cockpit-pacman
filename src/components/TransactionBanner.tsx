import React, { useEffect, useRef, useSyncExternalStore } from "react";
import { Alert, AlertActionCloseButton, AlertActionLink, Progress, ProgressSize } from "@patternfly/react-core";
import { TimeAgo } from "./TimeAgo";
import {
  OWNER_ROUTES,
  transactionLabel,
  transactionOwner,
  useActiveTransaction,
  useMutationGate,
  useOwnTransactionRunning,
  useTransactionOutcome,
  useTransactionProgress,
  type TransactionOwner,
} from "../hooks/useMutationGate";
import {
  dismissOutsideRun,
  dismissTransactionOutcome,
  getActiveTransaction,
  getOutsideRun,
  getTransactionOutcome,
  onActiveTransactionChanged,
  onOutsideRun,
  type OutsideRun,
  type TransactionOutcome,
} from "../api";
import { parseTimestamp } from "../timeFormat";
import { useAnnounce } from "../contexts/AnnouncerContext";
import type { RouteOptions } from "../hooks/useRoute";
import { useAdminPermission } from "../hooks/useAdminPermission";
import { GatedButton } from "./GatedButton";
import { formatAtLeast } from "./TransactionRisks";

const OUTCOME_SUBJECTS: Record<string, string> = {
  "upgrade": "Upgrade",
  "sync-database": "Database sync",
  "clean-cache": "Cache clean",
  "refresh-keyring": "Key refresh",
  "init-keyring": "Keyring initialization",
  "remove-orphans": "Orphan removal",
};

const OUTCOMES: Record<TransactionOutcome["status"], { variant: "success" | "custom" | "danger"; suffix: string; action: string }> = {
  success: { variant: "success", suffix: "finished", action: "View result" },
  stopped: { variant: "custom", suffix: "stopped", action: "View details" },
  failed: { variant: "danger", suffix: "failed", action: "View details" },
};

const HISTORY_SLUG = "history";

const UPGRADE_WAITING_HIDDEN = new Set(["cache", "updates"]);

/** A space-blocked upgrade that can be resumed once there is room. */
export interface UpgradeWaiting {
  deficit: number;
  mount: string;
}

export const upgradeWaitingText = ({ deficit, mount }: UpgradeWaiting) =>
  `An upgrade is waiting for ${formatAtLeast(deficit)} on ${mount}`;

const showsUpgradeWaiting = (waiting: UpgradeWaiting | null | undefined, slug: string, ownRunning: boolean) =>
  !!waiting && !ownRunning && !UPGRADE_WAITING_HIDDEN.has(slug);

const OUTSIDE_RUN_COUNTS: [keyof OutsideRun["counts"], string][] = [
  ["upgraded", "upgraded"],
  ["installed", "installed"],
  ["removed", "removed"],
  ["downgraded", "downgraded"],
  ["reinstalled", "reinstalled"],
];

/** A log timestamp as a clock time today, or a date and time otherwise. */
export function formatRunTime(startTime: string): string {
  const date = parseTimestamp(startTime);
  if (!date) return startTime;
  const today = date.toDateString() === new Date().toDateString();
  return today
    ? date.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })
    : date.toLocaleString([], { dateStyle: "medium", timeStyle: "short" });
}

const RUN_VERBS: Record<string, string> = {
  install: "Installed",
  remove: "Removed",
  upgrade: "Upgraded",
  "remove-orphans": "Removed orphan packages",
};

function listTargets(targets: string[], more: string | null): string {
  if (more) return `${targets.join(", ")} and ${more} more`;
  if (targets.length < 2) return targets.join("");
  return `${targets.slice(0, -1).join(", ")} and ${targets[targets.length - 1]}`;
}

/** Describes the action recorded in a Cockpit transaction marker. */
export function describeRun(command: string | null): string {
  const words = (command ?? "").split(" ").filter(Boolean);
  if (words[0] !== "cockpit-pacman" || words.length < 2) return "Changed packages";
  const [, verb, ...rest] = words;
  const capped = rest.length >= 3 && rest[rest.length - 3] === "and" && rest[rest.length - 1] === "more";
  const targets = capped ? rest.slice(0, -3) : rest;
  const more = capped ? rest[rest.length - 2] : null;
  if (verb === "downgrade" && targets.length === 2) return `Downgraded ${targets[0]} to ${targets[1]}`;
  const head = RUN_VERBS[verb];
  if (!head) return "Changed packages";
  return targets.length > 0 ? `${head} ${listTargets(targets, more)}` : head;
}

export function outsideRunText(run: OutsideRun): string {
  const counts = OUTSIDE_RUN_COUNTS
    .filter(([key]) => run.counts[key] > 0)
    .map(([key, label]) => `${run.counts[key]} ${label}`)
    .join(", ");
  const time = formatRunTime(run.startTime);
  let head: string;
  if (run.runs > 1) {
    head = `${run.runs} transactions were recorded since ${formatRunTime(run.firstStartTime)}`;
  } else if (run.origin === "scheduled") {
    head = `Scheduled upgrade ran at ${time}`;
  } else if (run.origin === "cockpit") {
    const action = describeRun(run.command);
    head = `A Cockpit session ${action.charAt(0).toLowerCase()}${action.slice(1)} at ${time}`;
  } else {
    head = `${run.command ?? "A transaction"} ran in a terminal or another session at ${time}`;
  }
  return counts ? `${head}: ${run.partial ? "at least " : ""}${counts}` : head;
}

function useOutsideRun(): OutsideRun | null {
  return useSyncExternalStore(onOutsideRun, getOutsideRun);
}

/** The banner's "View progress" link, focused when a dialog moves its run to the background. */
export const TRANSACTION_BANNER_ACTION_ID = "transaction-banner-view-progress";

function isOwnerView(owner: TransactionOwner | undefined, slug: string, options: RouteOptions): boolean {
  const route = owner ? OWNER_ROUTES[owner] : undefined;
  return !!route && route.slug === slug && (!route.options?.filter || route.options.filter === options.filter);
}

function outcomeTitle({ command, status }: TransactionOutcome): string | undefined {
  const subject = OUTCOME_SUBJECTS[command];
  return subject && `${subject} ${OUTCOMES[status].suffix}`;
}

/** Announces off-screen transaction progress. Mount once above the tabs. */
export function useTransactionAnnouncements(
  activeSlug: string,
  activeOptions: RouteOptions,
  upgradeWaiting?: UpgradeWaiting | null,
): void {
  const announce = useAnnounce();
  const viewRef = useRef({ slug: activeSlug, options: activeOptions });
  useEffect(() => {
    viewRef.current = { slug: activeSlug, options: activeOptions };
  }, [activeSlug, activeOptions]);

  useEffect(() => {
    let running = getActiveTransaction();
    let outcome = getTransactionOutcome();
    const offScreen = (command: string) => {
      const owner = transactionOwner(command);
      return !!owner && !isOwnerView(owner, viewRef.current.slug, viewRef.current.options);
    };
    return onActiveTransactionChanged((next) => {
      const prev = running;
      running = next;
      const started = next && !(prev && prev.command === next.command && prev.startedAt === next.startedAt);
      if (started) {
        if (next.command === "external") {
          announce(`${transactionLabel(next)} is running`);
        } else if (offScreen(next.command)) {
          announce(`${transactionLabel(next)} started`);
        }
      } else if (!next && prev?.command === "external") {
        announce(`${transactionLabel(prev)} finished`);
      }

      const nextOutcome = getTransactionOutcome();
      if (nextOutcome && nextOutcome !== outcome && offScreen(nextOutcome.command)) {
        const title = outcomeTitle(nextOutcome);
        if (title) announce(title, { assertive: nextOutcome.status === "failed" });
      }
      outcome = nextOutcome;
    });
  }, [announce]);

  const announcedRunRef = useRef<OutsideRun | null>(null);
  useEffect(() => {
    const announceOutsideRun = () => {
      const run = getOutsideRun();
      const own = getActiveTransaction();
      if (!run || run === announcedRunRef.current || (own && own.command !== "external")) return;
      announcedRunRef.current = run;
      if (viewRef.current.slug !== HISTORY_SLUG) announce(outsideRunText(run));
    };
    const unsubscribeRun = onOutsideRun(announceOutsideRun);
    const unsubscribeTransaction = onActiveTransactionChanged(announceOutsideRun);
    return () => {
      unsubscribeRun();
      unsubscribeTransaction();
    };
  }, [announce]);

  const outcome = useTransactionOutcome();
  useEffect(() => {
    if (outcome && isOwnerView(transactionOwner(outcome.command), activeSlug, activeOptions)) {
      dismissTransactionOutcome();
    }
  }, [outcome, activeSlug, activeOptions]);

  const ownRunning = useOwnTransactionRunning();
  const announcedWaitingRef = useRef<UpgradeWaiting | null>(null);
  useEffect(() => {
    if (!upgradeWaiting || announcedWaitingRef.current === upgradeWaiting) return;
    if (!showsUpgradeWaiting(upgradeWaiting, activeSlug, ownRunning)) return;
    announcedWaitingRef.current = upgradeWaiting;
    announce(upgradeWaitingText(upgradeWaiting));
  }, [upgradeWaiting, activeSlug, ownRunning, announce]);

  const outsideRun = useOutsideRun();
  useEffect(() => {
    if (outsideRun && activeSlug === HISTORY_SLUG) dismissOutsideRun();
  }, [outsideRun, activeSlug]);
}

interface TransactionBannerProps {
  activeSlug: string;
  activeOptions: RouteOptions;
  onNavigate: (slug: string, options?: RouteOptions) => void;
  upgradeWaiting?: UpgradeWaiting | null;
  /** Reruns the blocked upgrade's preview; it never commits by itself. */
  onBackToUpgrade?: () => void;
  onDismissUpgradeWaiting?: () => void;
}

const OutcomeBanner: React.FC<TransactionBannerProps & { outcome: TransactionOutcome }> = ({
  outcome,
  activeSlug,
  activeOptions,
  onNavigate,
}) => {
  const title = outcomeTitle(outcome);
  const owner = transactionOwner(outcome.command);
  if (!title || !owner || isOwnerView(owner, activeSlug, activeOptions)) return null;
  const route = OWNER_ROUTES[owner];
  const { variant, action } = OUTCOMES[outcome.status];
  return (
    <Alert
      variant={variant}
      isInline
      title={title}
      className="pf-v6-u-mb-md"
      actionClose={<AlertActionCloseButton onClose={dismissTransactionOutcome} />}
      actionLinks={<AlertActionLink onClick={() => onNavigate(route.slug, route.options)}>{action}</AlertActionLink>}
    />
  );
};

const BannerProgress: React.FC = () => {
  const transaction = useTransactionProgress();
  if (!transaction?.phase) return null;
  if (transaction.percent === undefined) {
    return <div className="pf-v6-u-mb-sm">{transaction.phase}</div>;
  }
  return (
    <Progress
      value={transaction.percent}
      title={transaction.phase}
      size={ProgressSize.sm}
      className="pf-v6-u-mb-sm"
    />
  );
};

const OutsideRunLine: React.FC<{ run: OutsideRun; onNavigate: TransactionBannerProps["onNavigate"] }> = ({
  run,
  onNavigate,
}) => (
  <Alert
    variant="info"
    isInline
    title={outsideRunText(run)}
    className="pf-v6-u-mb-md"
    actionClose={<AlertActionCloseButton onClose={dismissOutsideRun} />}
    actionLinks={<AlertActionLink onClick={() => onNavigate(HISTORY_SLUG, { at: run.firstStartTime })}>View in History</AlertActionLink>}
  />
);

const UpgradeWaitingLine: React.FC<{
  waiting: UpgradeWaiting;
  onBack?: () => void;
  onDismiss?: () => void;
}> = ({ waiting, onBack, onDismiss }) => {
  const gate = useMutationGate("upgrade packages", { permission: useAdminPermission() });
  return (
    <Alert
      variant="info"
      isInline
      title={upgradeWaitingText(waiting)}
      className="pf-v6-u-mb-md"
      actionClose={onDismiss && (
        <AlertActionCloseButton aria-label="Dismiss the waiting upgrade" onClose={onDismiss} />
      )}
      actionLinks={onBack && (
        <GatedButton gate={gate} variant="link" isInline onClick={onBack}>
          Back to upgrade
        </GatedButton>
      )}
    />
  );
};

/** Shows running work, its outcome, and blocked upgrades across tabs. Announcements use useTransactionAnnouncements. */
export const TransactionBanner: React.FC<TransactionBannerProps> = ({
  activeSlug,
  activeOptions,
  onNavigate,
  upgradeWaiting,
  onBackToUpgrade,
  onDismissUpgradeWaiting,
}) => {
  const transaction = useActiveTransaction();
  const outcome = useTransactionOutcome();
  const outsideRun = useOutsideRun();
  const ownRunning = useOwnTransactionRunning();
  const outsideLine = (
    <>
      {outsideRun && !ownRunning && activeSlug !== HISTORY_SLUG && (
        <OutsideRunLine run={outsideRun} onNavigate={onNavigate} />
      )}
      {upgradeWaiting && showsUpgradeWaiting(upgradeWaiting, activeSlug, ownRunning) && (
        <UpgradeWaitingLine waiting={upgradeWaiting} onBack={onBackToUpgrade} onDismiss={onDismissUpgradeWaiting} />
      )}
    </>
  );
  if (!transaction) {
    return (
      <>
        {outcome && (
          <OutcomeBanner outcome={outcome} activeSlug={activeSlug} activeOptions={activeOptions} onNavigate={onNavigate} />
        )}
        {outsideLine}
      </>
    );
  }

  const external = transaction.command === "external";
  const owner = transactionOwner(transaction.command);
  const route = owner ? OWNER_ROUTES[owner] : undefined;
  if (!transaction.reopen && isOwnerView(owner, activeSlug, activeOptions)) return null;
  const viewProgress = transaction.reopen ?? (route && (() => onNavigate(route.slug, route.options)));

  return (
    <>
    <Alert
      variant="info"
      isInline
      title={`${transactionLabel(transaction)} is running`}
      className="pf-v6-u-mb-md"
      actionLinks={
        viewProgress && (
          <AlertActionLink id={TRANSACTION_BANNER_ACTION_ID} onClick={viewProgress}>View progress</AlertActionLink>
        )
      }
    >
      {!external && <BannerProgress />}
      {!external && <>Started <TimeAgo timestamp={transaction.startedAt / 1000} />. </>}
      Other package changes are unavailable until it finishes.
    </Alert>
    {outsideLine}
    </>
  );
};
