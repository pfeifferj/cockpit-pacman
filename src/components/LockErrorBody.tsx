import React, { useState, useEffect } from "react";
import { Button, Content, ContentVariants } from "@patternfly/react-core";
import { checkLock, removeStaleLock } from "../api";

export const LockErrorBody: React.FC<{ onRetry: () => void; onAutoRetry: () => void; onCleared: () => void }> = ({ onRetry, onAutoRetry, onCleared }) => {
  const [checking, setChecking] = useState(true);
  const [removing, setRemoving] = useState(false);
  const [lockInfo, setLockInfo] = useState<{ stale: boolean; process?: string; unknown: boolean } | null>(null);
  const [removeError, setRemoveError] = useState<string | null>(null);
  const [checkFailed, setCheckFailed] = useState(false);

  useEffect(() => {
    let cancelled = false;
    checkLock()
      .then((status) => {
        if (cancelled) return;
        if (!status.locked) {
          onAutoRetry();
          return;
        }
        setLockInfo({
          stale: status.stale,
          process: status.blocking_process,
          unknown: status.holder_unknown,
        });
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
    return () => { cancelled = true; };
  }, [onAutoRetry]);

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

  if (checking) {
    return <Content component={ContentVariants.p}>Checking lock status...</Content>;
  }

  if (lockInfo?.stale === false && lockInfo.process) {
    return (
      <Content component={ContentVariants.p}>
        The database is locked by <strong>{lockInfo.process}</strong>. Wait for it to finish, then retry.
      </Content>
    );
  }

  // Offering removal here would be acting on a check that did not conclude.
  // A session without administrative access cannot see root's open files, so
  // it finds no holder for a lock a running pacman still owns.
  if (checkFailed || lockInfo?.unknown) {
    return (
      <Content component={ContentVariants.p}>
        Could not determine whether the database lock is still in use. This check needs
        administrative access. Grant it and retry, or wait for the running operation to finish.
      </Content>
    );
  }

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
        <Button variant="primary" onClick={handleRemoveLock} isLoading={removing} isDisabled={removing}>
          Remove stale lock and retry
        </Button>
      </Content>
    </>
  );
};
