import { useEffect, useSyncExternalStore } from "react";
import {
  getActiveTransaction,
  getTransactionOutcome,
  onActiveTransactionChanged,
  refreshExternalLockHolder,
  type ActiveTransaction,
  type TransactionOutcome,
} from "../api";
import type { RouteOptions } from "./useRoute";
import { usePageVisible } from "./usePageVisible";

/** The view whose progress display belongs to a running command. */
export type TransactionOwner = "updates" | "cache" | "keyring" | "orphans";

const OWNERS: Record<string, TransactionOwner> = {
  "upgrade": "updates",
  "sync-database": "updates",
  "clean-cache": "cache",
  "refresh-keyring": "keyring",
  "init-keyring": "keyring",
  "remove-orphans": "orphans",
};

/** Owner of a command; install, remove and downgrade run in modals and have none. */
export function transactionOwner(command: string): TransactionOwner | undefined {
  return OWNERS[command];
}

/** Sentence-start label for a running command, e.g. "An upgrade", "Installing vim" or "pacman (pid 42)". */
export function transactionLabel({ command, target }: ActiveTransaction): string {
  const pkg = target || "a package";
  switch (command) {
    case "external": return target || "Another program";
    case "upgrade": return "An upgrade";
    case "sync-database": return "A database sync";
    case "install-package": return `Installing ${pkg}`;
    case "remove-package": return `Removing ${pkg}`;
    case "remove-orphans": return "Orphan removal";
    case "downgrade":
    case "downgrade-archive": return `Downgrading ${pkg}`;
    case "clean-cache": return "A cache clean";
    case "refresh-keyring": return "A key refresh";
    case "init-keyring": return "Keyring initialization";
    default: return "A package transaction";
  }
}

let lastSource: ActiveTransaction | null = null;
let lastStable: ActiveTransaction | null = null;

function sameRun(a: ActiveTransaction | null, b: ActiveTransaction | null): boolean {
  return !!a && !!b && a.command === b.command && a.target === b.target &&
    a.startedAt === b.startedAt && a.reopen === b.reopen;
}

// Progress updates replace the registry entry several times a second; gates only care about the run.
function getStableTransaction(): ActiveTransaction | null {
  const current = getActiveTransaction();
  if (current !== lastSource) {
    lastSource = current;
    if (!sameRun(current, lastStable)) lastStable = current;
  }
  return lastStable;
}

/**
 * The running transaction, re-rendering on start, end and reopen changes
 * only. Its phase and percent can lag; read those with useTransactionProgress.
 */
export function useActiveTransaction(): ActiveTransaction | null {
  return useSyncExternalStore(onActiveTransactionChanged, getStableTransaction);
}

/** The running transaction including its latest phase and percent. */
export function useTransactionProgress(): ActiveTransaction | null {
  return useSyncExternalStore(onActiveTransactionChanged, getActiveTransaction);
}

export function useTransactionOutcome(): TransactionOutcome | null {
  return useSyncExternalStore(onActiveTransactionChanged, getTransactionOutcome);
}

const ownRunning = () => {
  const transaction = getActiveTransaction();
  return transaction !== null && transaction.command !== "external";
};

/** Whether this page itself runs a system-changing command. */
export function useOwnTransactionRunning(): boolean {
  return useSyncExternalStore(onActiveTransactionChanged, ownRunning);
}

/** How often db.lck is checked for an outside holder while the page is shown. */
export const EXTERNAL_LOCK_POLL_MS = 15_000;

/** Checks external lock holders on activation and polls while the page is visible. */
export function useExternalLockWatch(activationKey: unknown): void {
  const { visible } = usePageVisible();
  useEffect(() => {
    if (!visible) return;
    const check = () => {
      refreshExternalLockHolder().catch(() => undefined);
    };
    check();
    const timer = window.setInterval(check, EXTERNAL_LOCK_POLL_MS);
    return () => window.clearInterval(timer);
  }, [visible, activationKey]);
}

export interface MutationGate {
  blocked: boolean;
  reason?: string;
}

/**
 * Whether a mutation can start, and why not. Reasons in priority order:
 * the access check is pending, access is off, another transaction runs.
 * @param action verb phrase completing "Turn on administrative access to ..."
 * @param permission value from useAdminPermission
 * @param owner the running command's own view is not blocked by it
 */
export function mutationGate(
  action: string,
  permission: boolean | null,
  transaction: ActiveTransaction | null,
  owner?: TransactionOwner,
): MutationGate {
  if (permission === null) return { blocked: true, reason: "Checking administrative access…" };
  if (permission === false) return { blocked: true, reason: `Turn on administrative access to ${action}` };
  if (transaction && !(owner && transactionOwner(transaction.command) === owner)) {
    return { blocked: true, reason: `${transactionLabel(transaction)} is running.` };
  }
  return { blocked: false };
}

export function useMutationGate(
  action: string,
  { permission, owner }: { permission: boolean | null; owner?: TransactionOwner },
): MutationGate {
  return mutationGate(action, permission, useActiveTransaction(), owner);
}

export const OWNER_ROUTES: Record<TransactionOwner, { slug: string; options?: RouteOptions }> = {
  updates: { slug: "updates" },
  cache: { slug: "cache" },
  keyring: { slug: "keyring" },
  orphans: { slug: "installed", options: { filter: "orphan" } },
};
