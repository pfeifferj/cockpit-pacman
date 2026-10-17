import React, { useState } from "react";
import {
  Alert,
  AlertActionCloseButton,
  AlertActionLink,
  Button,
  EmptyState,
  EmptyStateActions,
  EmptyStateBody,
  EmptyStateFooter,
} from "@patternfly/react-core";
import { ExclamationCircleIcon } from "@patternfly/react-icons";
import { BackendError, type ErrorCode } from "../api";
import { isDbLockError, sanitizeErrorMessage } from "../utils";
import { ErrorDetails } from "./ErrorDetails";
import { useFailureAnnouncement } from "./ErrorAlert";
import { HOST_RETRY_HIDDEN, LockErrorBody, type LockWaitState } from "./LockErrorBody";

export interface LoadFailure {
  message: string;
  code?: ErrorCode;
  details?: string;
}

export function toLoadFailure(ex: unknown): LoadFailure {
  return {
    message: ex instanceof Error ? ex.message : String(ex),
    code: ex instanceof BackendError ? ex.code : undefined,
    details: ex instanceof BackendError ? ex.details : undefined,
  };
}

interface LoadErrorStateProps {
  /** Object of "Could not load ...", e.g. "history". */
  what: string;
  error: string | null | undefined;
  /** With database_locked, the body waits for the lock holder and retries on release. */
  code?: ErrorCode;
  details?: string;
  onRetry: () => void;
  action?: React.ReactNode;
  /** "secondary" when action is the real recovery; action then renders first. */
  retryVariant?: "primary" | "secondary";
  headingLevel?: "h2" | "h3";
}

/** Full-area state for a load that failed with nothing to show. */
export const LoadErrorState: React.FC<LoadErrorStateProps> = ({
  what, error, code, details, onRetry, action, retryVariant = "primary", headingLevel = "h2",
}) => {
  const [lockState, setLockState] = useState<LockWaitState>("checking");
  const title = `Could not load ${what}`;
  const message = sanitizeErrorMessage(error);
  const locked = isDbLockError(error ?? "", code);
  useFailureAnnouncement(locked ? `${title}. The package database is locked.` : `${title}. ${message}`);
  const showRetry = !locked || !HOST_RETRY_HIDDEN.has(lockState);
  return (
    <EmptyState
      headingLevel={headingLevel}
      icon={ExclamationCircleIcon}
      titleText={title}
      status={locked ? "warning" : "danger"}
    >
      <EmptyStateBody>
        {locked ? (
          <LockErrorBody
            onRetry={onRetry}
            onAutoRetry={onRetry}
            onCleared={() => {}}
            retryKey={`${title}\n${error ?? ""}`}
            onStateChange={setLockState}
          />
        ) : (
          <>
            {message}
            <ErrorDetails details={details} />
          </>
        )}
      </EmptyStateBody>
      {(showRetry || action) && (
        <EmptyStateFooter>
          <EmptyStateActions>
            {retryVariant === "secondary" && action}
            {showRetry && <Button variant={retryVariant} onClick={onRetry}>Try again</Button>}
            {retryVariant === "primary" && action}
          </EmptyStateActions>
        </EmptyStateFooter>
      )}
    </EmptyState>
  );
};

interface RefreshFailedAlertProps {
  /** Object of "Could not refresh ...", e.g. "history". */
  what: string;
  error: string;
  details?: string;
  onRetry: () => void;
  onClose?: () => void;
  className?: string;
}

/** A background reload failed; the data on screen stays and may be out of date. */
export const RefreshFailedAlert: React.FC<RefreshFailedAlertProps> = ({
  what, error, details, onRetry, onClose, className = "pf-v6-u-mb-md",
}) => {
  const title = `Could not refresh ${what}`;
  const message = sanitizeErrorMessage(error);
  useFailureAnnouncement(title);
  return (
    <Alert
      variant="warning"
      isInline
      title={title}
      className={className}
      actionLinks={<AlertActionLink onClick={onRetry}>Try again</AlertActionLink>}
      actionClose={onClose && <AlertActionCloseButton title={title} onClose={onClose} />}
    >
      <p>{message}</p>
      <p>What is shown was current at the last successful load.</p>
      <ErrorDetails details={details} />
    </Alert>
  );
};
