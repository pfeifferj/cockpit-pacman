import React, { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import { Alert, AlertActionCloseButton, AlertActionLink } from "@patternfly/react-core";
import { dismissTransactionOutcome, type ErrorCode, type StreamingHandle, type UpgradeCallbacks } from "../api";
import { useAnnounce } from "../contexts/AnnouncerContext";
import { appendCapped } from "../utils";
import { LOG_FLUSH_MS } from "../constants";
import { initialProgress, reduceProgress, type ProgressPlan, type ProgressState } from "../progress";
import { TRANSACTION_BANNER_ACTION_ID } from "./TransactionBanner";

export type RunStatus = "running" | "cancelling" | "success" | "stopped" | "failed";
export type RunOutcome = Extract<RunStatus, "success" | "stopped" | "failed">;

const OUTCOME_SUFFIX: Record<RunOutcome, string> = { success: "finished", stopped: "stopped", failed: "failed" };

export interface RunSnapshot {
  status: RunStatus;
  log: string;
  progress: ProgressState;
  error: string | null;
  errorCode?: ErrorCode;
  errorDetails?: string;
  /** The run succeeded although a stop had been requested. */
  finishedAfterCancel: boolean;
}

/** Keeps a transaction's stream and display state alive after its dialog closes. */
export class RunSession {
  private snapshot: RunSnapshot = {
    status: "running",
    log: "",
    progress: initialProgress,
    error: null,
    finishedAfterCancel: false,
  };
  private readonly listeners = new Set<() => void>();
  private handle: StreamingHandle | null = null;
  private cancelRequested = false;
  private pending: Partial<RunSnapshot> = {};
  private timer: ReturnType<typeof setTimeout> | undefined;

  /** @param title dialog title naming the action, e.g. "Install vim" */
  constructor(readonly title: string) {}

  start(run: (callbacks: UpgradeCallbacks) => StreamingHandle, plan: ProgressPlan, onSuccess?: () => void): void {
    const handle = run({
      onEvent: (event) => this.queue({ progress: reduceProgress(this.pending.progress ?? this.snapshot.progress, event, plan) }),
      onData: (data) => this.queue({ log: appendCapped(this.pending.log ?? this.snapshot.log, data) }),
      onComplete: () => {
        this.handle = null;
        this.update({ status: "success", finishedAfterCancel: this.cancelRequested });
        onSuccess?.();
      },
      onError: (error, errorCode, errorDetails) => {
        this.handle = null;
        this.update({
          status: this.cancelRequested && errorCode === "cancelled" ? "stopped" : "failed",
          error,
          errorCode,
          errorDetails,
        });
      },
    });
    this.handle = this.running ? handle : null;
  }

  get running(): boolean {
    return this.snapshot.status === "running" || this.snapshot.status === "cancelling";
  }

  /** Requests cancellation; completion waits for backend exit. */
  stop(): void {
    if (!this.running || this.cancelRequested) return;
    this.cancelRequested = true;
    this.update({ status: "cancelling" });
    this.handle?.cancel();
  }

  /** Cancels the run when the dialog that owns it goes away. */
  abandon(): void {
    this.handle?.cancel();
    this.handle = null;
  }

  /** Outcome title used by host alerts and announcements. */
  outcomeTitle(status: RunOutcome): string {
    return `${this.title} ${OUTCOME_SUFFIX[status]}`;
  }

  setReopen(reopen: (() => void) | undefined): void {
    this.handle?.setReopen?.(reopen);
  }

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  };

  getSnapshot = (): RunSnapshot => this.snapshot;

  private queue(patch: Partial<RunSnapshot>): void {
    this.pending = { ...this.pending, ...patch };
    this.timer ??= setTimeout(() => this.update({}), LOG_FLUSH_MS);
  }

  private update(patch: Partial<RunSnapshot>): void {
    if (this.timer !== undefined) clearTimeout(this.timer);
    this.timer = undefined;
    this.snapshot = { ...this.snapshot, ...this.pending, ...patch };
    this.pending = {};
    for (const listener of [...this.listeners]) listener();
  }
}

const noSubscribe = () => () => {};
const noSnapshot = () => null;

export function useRunSnapshot(session: RunSession | null): RunSnapshot | null {
  return useSyncExternalStore(session?.subscribe ?? noSubscribe, session?.getSnapshot ?? noSnapshot);
}

export interface BackgroundRun {
  session: RunSession;
  /** Renders the run's dialog again; `onClose` hands it back to the host. */
  render: (onClose: () => void) => React.ReactNode;
  /**
   * The view that started the run and takes it back with useHeldRun when it
   * mounts again. The view handed the run over by unmounting, so focus stays
   * where the user put it.
   */
  owner?: string;
  /** Shows the run in its owner view; View progress uses it instead of the dialog. */
  navigate?: () => void;
}

interface HostValue {
  adopt: (run: BackgroundRun) => void;
  release: (session: RunSession) => void;
  run: BackgroundRun | null;
  open: boolean;
  setOpen: (open: boolean) => void;
  dismiss: () => void;
}

const TransactionHostContext = createContext<HostValue | null>(null);

/** Moves a dialog's run to the page-level host; null outside a TransactionHostProvider. */
export function useRunInBackground(): ((run: BackgroundRun) => void) | null {
  return useContext(TransactionHostContext)?.adopt ?? null;
}

/**
 * The run the host holds for `owner`, and `release`, which takes it back from
 * the host so the owner view can show it again.
 */
export function useHeldRun(owner: string): { run: BackgroundRun | null; release: (session: RunSession) => void } {
  const host = useContext(TransactionHostContext);
  const run = host?.run?.owner === owner ? host.run : null;
  return { run, release: host?.release ?? noRelease };
}

const noRelease = () => {};

export const TransactionHostProvider: React.FC<{ children: React.ReactNode }> = ({ children }) => {
  const [run, setRun] = useState<BackgroundRun | null>(null);
  const [open, setOpen] = useState(false);
  const announce = useAnnounce();
  // Read by release, which an owner view may call in the same commit as adopt.
  const runRef = useRef<BackgroundRun | null>(null);

  const adopt = useCallback((next: BackgroundRun) => {
    runRef.current = next;
    setRun(next);
    setOpen(false);
    next.session.setReopen(next.navigate ?? (() => setOpen(true)));
    announce(`${next.session.title} continues in the background`);
    if (next.owner) return;
    // Runs after the dialog's focus trap has returned focus to its trigger, which may be gone.
    setTimeout(() => document.getElementById(TRANSACTION_BANNER_ACTION_ID)?.focus(), 0);
  }, [announce]);

  const release = useCallback((session: RunSession) => {
    if (runRef.current?.session !== session) return;
    session.setReopen(undefined);
    runRef.current = null;
    setRun(null);
    setOpen(false);
  }, []);

  const dismiss = useCallback(() => {
    runRef.current = null;
    setRun(null);
    setOpen(false);
  }, []);

  const value = useMemo(() => ({ adopt, release, run, open, setOpen, dismiss }), [adopt, release, run, open, dismiss]);
  return <TransactionHostContext.Provider value={value}>{children}</TransactionHostContext.Provider>;
};

const OUTCOME: Record<RunOutcome, { variant: "success" | "custom" | "danger"; action: string }> = {
  success: { variant: "success", action: "View result" },
  stopped: { variant: "custom", action: "View details" },
  failed: { variant: "danger", action: "View details" },
};

/** Shows a backgrounded run's dialog when reopened, and its outcome once it ends. */
export const TransactionHost: React.FC = () => {
  const host = useContext(TransactionHostContext);
  const run = host?.run ?? null;
  const snapshot = useRunSnapshot(run?.session ?? null);
  const announce = useAnnounce();
  const announcedRef = useRef<RunSession | null>(null);

  const status = snapshot?.status;
  const ended = status === "success" || status === "stopped" || status === "failed";
  const open = host?.open ?? false;

  useEffect(() => {
    if (!run || !ended || open || announcedRef.current === run.session) return;
    announcedRef.current = run.session;
    announce(run.session.outcomeTitle(status));
    // An owner view's command also has a tab-level outcome banner; this Alert replaces it.
    if (run.owner) dismissTransactionOutcome();
  }, [run, ended, open, status, announce]);

  if (!host || !run) return null;

  if (open) {
    return <>{run.render(() => (run.session.running ? host.setOpen(false) : host.dismiss()))}</>;
  }

  if (!ended) return null;

  const outcome = OUTCOME[status];
  return (
    <Alert
      variant={outcome.variant}
      isInline
      title={run.session.outcomeTitle(status)}
      className="pf-v6-u-mb-md"
      actionClose={<AlertActionCloseButton onClose={host.dismiss} />}
      actionLinks={<AlertActionLink onClick={() => host.setOpen(true)}>{outcome.action}</AlertActionLink>}
    />
  );
};
