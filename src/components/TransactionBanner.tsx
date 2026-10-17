import React, { useEffect, useRef } from "react";
import { Alert, AlertActionCloseButton, AlertActionLink, Progress, ProgressSize } from "@patternfly/react-core";
import { TimeAgo } from "./TimeAgo";
import {
  transactionLabel,
  transactionOwner,
  useActiveTransaction,
  useTransactionOutcome,
  useTransactionProgress,
  OWNER_ROUTES,
  type TransactionOwner,
} from "../hooks/useMutationGate";
import {
  dismissTransactionOutcome,
  getActiveTransaction,
  getTransactionOutcome,
  onActiveTransactionChanged,
  type TransactionOutcome,
} from "../api";
import { useAnnounce } from "../contexts/AnnouncerContext";
import type { RouteOptions } from "../hooks/useRoute";

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

/** Mount once above the tabs. Announces off-screen runs and dismisses outcomes when their owner becomes visible. */
export function useTransactionAnnouncements(activeSlug: string, activeOptions: RouteOptions): void {
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

  const outcome = useTransactionOutcome();
  useEffect(() => {
    if (outcome && isOwnerView(transactionOwner(outcome.command), activeSlug, activeOptions)) {
      dismissTransactionOutcome();
    }
  }, [outcome, activeSlug, activeOptions]);
}

interface TransactionBannerProps {
  activeSlug: string;
  activeOptions: RouteOptions;
  onNavigate: (slug: string, options?: RouteOptions) => void;
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

/**
 * Points back to a running transaction from every tab except the one showing
 * its progress, names an outside lock holder, and keeps a finished run's
 * outcome until dismissed. Not a live region; see useTransactionAnnouncements.
 */
export const TransactionBanner: React.FC<TransactionBannerProps> = ({ activeSlug, activeOptions, onNavigate }) => {
  const transaction = useActiveTransaction();
  const outcome = useTransactionOutcome();
  if (!transaction) {
    return outcome ? (
      <OutcomeBanner outcome={outcome} activeSlug={activeSlug} activeOptions={activeOptions} onNavigate={onNavigate} />
    ) : null;
  }

  const external = transaction.command === "external";
  const owner = transactionOwner(transaction.command);
  const route = owner ? OWNER_ROUTES[owner] : undefined;
  if (!transaction.reopen && isOwnerView(owner, activeSlug, activeOptions)) return null;
  const viewProgress = transaction.reopen ?? (route && (() => onNavigate(route.slug, route.options)));

  return (
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
  );
};
