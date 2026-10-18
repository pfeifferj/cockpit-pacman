import React, { useState, useEffect, useRef } from "react";
import { Button, Content, ContentVariants } from "@patternfly/react-core";
import { checkLock, removeStaleLock } from "../api";
import { useAnnounce } from "../contexts/AnnouncerContext";

export const LOCK_POLL_MS = 3000;
export const LOCK_WAIT_LIMIT_MS = 10 * 60 * 1000;
const ELAPSED_TICK_MS = 1000;
const AUTO_RETRY_WINDOW_MS = 30_000;

// Module scope because hosts clear the error while retrying, which remounts
// this body. The lock heuristic also matches failures a free lock does not
// fix, so one key gets one automatic retry per window, not a loop.
let lastAutoRetry: { key: string; at: number } | null = null;

function claimAutoRetry(key: string): boolean {
  const now = Date.now();
  if (lastAutoRetry && lastAutoRetry.key === key && now - lastAutoRetry.at < AUTO_RETRY_WINDOW_MS) return false;
  lastAutoRetry = { key, at: now };
  return true;
}

export function formatElapsed(ms: number): string {
  const total = Math.round(ms / 1000);
  if (total < 60) return `${total} s`;
  const seconds = total % 60;
  return seconds === 0 ? `${total / 60} min` : `${Math.floor(total / 60)} min ${seconds} s`;
}

/**
 * What the body is showing. A host offers its own retry control only in
 * stopped, timedOut, stale, indeterminate and free; in the others the body
 * is checking, waiting or already retrying.
 */
export type LockWaitState =
  | "checking"
  | "waiting"
  | "stopped"
  | "timedOut"
  | "stale"
  | "indeterminate"
  | "released"
  | "free";

/** States in which a host hides its own retry control. */
export const HOST_RETRY_HIDDEN: ReadonlySet<LockWaitState> = new Set(["checking", "waiting", "released"]);

type Wait = "waiting" | "stopped" | "timedOut";

interface LockInfo {
  stale: boolean;
  process?: string;
  unknown: boolean;
}

const isLive = (info: LockInfo | null): info is LockInfo & { process: string } =>
  info !== null && !info.stale && !!info.process && !info.unknown;

/**
 * Explains a database lock and recovers from it. A live holder is polled
 * until it exits, then onReleased runs once; no lock at the first check
 * calls onAutoRetry.
 * @param onRetry manual retry, after a stale lock is removed
 * @param onAutoRetry the first check found no lock
 * @param onReleased a held lock was seen to clear; defaults to onAutoRetry
 * @param onCleared a stale lock file was removed
 * @param retryKey with it, onAutoRetry runs at most once per key within 30 s across remounts
 * @param retryLabel name of the host's retry control, used in the copy
 * @param onStateChange reports what the body shows, so the host can hide its retry while waiting
 */
export const LockErrorBody: React.FC<{
  onRetry: () => void;
  onAutoRetry: () => void;
  onReleased?: () => void;
  onCleared: () => void;
  retryKey?: string;
  retryLabel?: string;
  onStateChange?: (state: LockWaitState) => void;
}> = ({ onRetry, onAutoRetry, onReleased, onCleared, retryKey, retryLabel = "Try again", onStateChange }) => {
  const [checking, setChecking] = useState(true);
  const [removing, setRemoving] = useState(false);
  const [lockInfo, setLockInfo] = useState<LockInfo | null>(null);
  const [removeError, setRemoveError] = useState<string | null>(null);
  const [checkFailed, setCheckFailed] = useState(false);
  const [released, setReleased] = useState(false);
  const [retryRefused, setRetryRefused] = useState(false);
  const [wait, setWait] = useState<Wait>("waiting");
  const [round, setRound] = useState(0);
  const [elapsed, setElapsed] = useState(0);
  const announce = useAnnounce();
  const stoppedTextRef = useRef<HTMLDivElement>(null);
  const stopButtonRef = useRef<HTMLElement>(null);
  const focusStopRef = useRef(false);
  const startedAtRef = useRef<number | null>(null);
  // Hosts pass fresh closures each render; the check runs once per mount.
  const callbacks = useRef({ onAutoRetry, onReleased: onReleased ?? onAutoRetry, onStateChange, announce, retryKey });
  useEffect(() => {
    callbacks.current = { onAutoRetry, onReleased: onReleased ?? onAutoRetry, onStateChange, announce, retryKey };
  });

  useEffect(() => {
    let cancelled = false;
    checkLock()
      .then((status) => {
        if (cancelled) return;
        if (!status.locked) {
          const key = callbacks.current.retryKey;
          if (key !== undefined && !claimAutoRetry(key)) {
            setRetryRefused(true);
            return;
          }
          setReleased(true);
          callbacks.current.onAutoRetry();
          return;
        }
        setLockInfo({ stale: status.stale, process: status.blocking_process, unknown: status.holder_unknown });
      })
      .catch(() => {
        if (cancelled) return;
        setLockInfo(null);
        setCheckFailed(true);
      })
      .finally(() => {
        if (cancelled) return;
        setChecking(false);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  const live = isLive(lockInfo) && !released;
  const polling = live && wait === "waiting";

  // One polling round; Keep waiting starts a new one with a fresh time limit.
  useEffect(() => {
    if (!polling) return;
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let waited = 0;
    if (startedAtRef.current === null) startedAtRef.current = Date.now();
    const startedAt = startedAtRef.current;
    const ticker = window.setInterval(() => setElapsed(Date.now() - startedAt), ELAPSED_TICK_MS);

    const timeOut = () => {
      const total = Date.now() - startedAt;
      setElapsed(total);
      setWait("timedOut");
      callbacks.current.announce(`Still locked after ${formatElapsed(total)}`);
    };

    const poll = () => {
      timer = setTimeout(() => {
        waited += LOCK_POLL_MS;
        checkLock()
          .then((status) => {
            if (cancelled) return;
            if (!status.locked) {
              cancelled = true;
              setReleased(true);
              callbacks.current.announce("Database lock released");
              callbacks.current.onReleased();
              return;
            }
            setLockInfo({ stale: status.stale, process: status.blocking_process, unknown: status.holder_unknown });
            if (status.stale || !status.blocking_process || status.holder_unknown) return;
            if (waited >= LOCK_WAIT_LIMIT_MS) {
              timeOut();
              return;
            }
            poll();
          })
          .catch(() => {
            if (cancelled) return;
            if (waited >= LOCK_WAIT_LIMIT_MS) {
              timeOut();
              return;
            }
            poll();
          });
      }, LOCK_POLL_MS);
    };
    poll();
    return () => {
      cancelled = true;
      clearTimeout(timer);
      window.clearInterval(ticker);
    };
  }, [polling, round]);

  const state: LockWaitState = released
    ? "released"
    : retryRefused
      ? "free"
      : checking
        ? "checking"
        : live
          ? wait
          : checkFailed || lockInfo?.unknown
            ? "indeterminate"
            : "stale";

  useEffect(() => {
    callbacks.current.onStateChange?.(state);
  }, [state]);

  useEffect(() => {
    if (state === "stopped") stoppedTextRef.current?.focus();
    if (state === "waiting" && focusStopRef.current) {
      focusStopRef.current = false;
      stopButtonRef.current?.focus();
    }
  }, [state]);

  const handleKeepWaiting = () => {
    focusStopRef.current = true;
    setWait("waiting");
    setRound((r) => r + 1);
  };

  const handleRemoveLock = async () => {
    setRemoving(true);
    setRemoveError(null);
    try {
      const result = await removeStaleLock();
      if (result.removed) {
        onCleared();
        onRetry();
      } else {
        setRemoveError(result.error || "Failed to remove lock");
      }
    } catch (ex) {
      setRemoveError(ex instanceof Error ? ex.message : String(ex));
    } finally {
      setRemoving(false);
    }
  };

  const keepWaiting = (
    <Content component={ContentVariants.p} className="pf-v6-u-mt-sm">
      <Button variant="secondary" onClick={handleKeepWaiting}>
        Keep waiting
      </Button>
    </Content>
  );

  switch (state) {
    case "released":
      return <Content component={ContentVariants.p}>The database is no longer locked.</Content>;

    case "free":
      return (
        <Content component={ContentVariants.p}>
          The database is not locked now, but the operation failed again. Select {retryLabel} to try once more.
        </Content>
      );

    case "checking":
      return <Content component={ContentVariants.p}>Checking lock status…</Content>;

    case "waiting":
      return (
        <>
          <Content component={ContentVariants.p}>
            Waiting for <strong>{lockInfo?.process}</strong> to finish
            {elapsed > 0 && ` (${formatElapsed(elapsed)})`}. This continues on its own when the lock is released.
          </Content>
          <Content component={ContentVariants.p} className="pf-v6-u-mt-sm">
            <Button variant="link" isInline onClick={() => setWait("stopped")} ref={stopButtonRef}>
              Stop waiting
            </Button>
          </Content>
        </>
      );

    case "timedOut":
      return (
        <>
          <Content component={ContentVariants.p}>
            Still locked after {formatElapsed(elapsed)}. <strong>{lockInfo?.process}</strong> is still
            running. Keep waiting, or select {retryLabel} once it finishes.
          </Content>
          {keepWaiting}
        </>
      );

    case "stopped":
      return (
        <div ref={stoppedTextRef} tabIndex={-1}>
          <Content component={ContentVariants.p}>
            The database is locked by <strong>{lockInfo?.process}</strong>. Wait for it to finish, then
            select {retryLabel}.
          </Content>
          {keepWaiting}
        </div>
      );

    // Offering removal here would be acting on a check that did not conclude.
    // A session without administrative access cannot see root's open files, so
    // it finds no holder for a lock a running pacman still owns.
    case "indeterminate":
      return (
        <Content component={ContentVariants.p}>
          Could not determine whether the database lock is still in use. This check needs
          administrative access. Turn it on and select {retryLabel}, or wait for the running operation
          to finish.
        </Content>
      );

    case "stale":
      return (
        <>
          <Content component={ContentVariants.p}>
            A stale lock file is blocking database access. No package manager process is running.
          </Content>
          {removeError && (
            <Content component={ContentVariants.p} className="pf-v6-u-mt-sm pf-v6-u-danger-color-100">
              {removeError}
            </Content>
          )}
          <Content component={ContentVariants.p} className="pf-v6-u-mt-sm">
            <Button variant="secondary" onClick={handleRemoveLock} isLoading={removing} isDisabled={removing}>
              Remove stale lock and retry
            </Button>
          </Content>
        </>
      );
  }
};
