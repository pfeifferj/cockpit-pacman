import React, { useEffect, useState } from "react";
import { Alert, AlertActionLink } from "@patternfly/react-core";
import { isDbLockError } from "../utils";
import { ErrorDetails } from "./ErrorDetails";
import { parseErrorCode, type ErrorCode } from "../api";
import { useNavigation, type KeyringContext } from "../contexts/NavigationContext";
import { LockErrorBody, type LockWaitState } from "./LockErrorBody";
import { useAnnounce } from "../contexts/AnnouncerContext";

const RETRY_LABEL = "Try again";
const SIGNATURE_TITLE = "Package signature could not be verified";
const LOCKED_TITLE = "Database is locked";
const RETRY_HIDDEN: ReadonlySet<LockWaitState> = new Set(["checking", "waiting", "released"]);

/** Announces a failure when its message changes. */
export function useFailureAnnouncement(message: string | null): void {
  const announce = useAnnounce();
  useEffect(() => {
    if (message) announce(message);
  }, [announce, message]);
}

interface ErrorAlertProps {
  error: string;
  headingLevel?: "h1" | "h2" | "h3" | "h4" | "h5" | "h6";
  code?: ErrorCode;
  title: string;
  lockMessage?: string;
  className?: string;
  isInline?: boolean;
  /** Backend context chain (BackendError.details), shown under the message. */
  details?: string;
  /** Runs before a navigation action leaves this view, so a modal host can close itself first. */
  beforeNavigate?: () => void;
  /** Re-runs the failed operation. A lock error then waits for the holder and retries on release. */
  onRetry?: () => void;
  /** Also offers Try again for failures other than a lock. Hosts with their own retry button leave it off. */
  showRetry?: boolean;
  /** Names the failed operation for the Keyring tab on a signature failure. */
  signatureOrigin?: Omit<KeyringContext, "retry">;
}

/**
 * Error alert that downgrades to a warning when pacman's database is locked,
 * and routes signature failures to the Keyring tab.
 */
export const ErrorAlert: React.FC<ErrorAlertProps> = ({
  error,
  headingLevel,
  code,
  title,
  lockMessage = "Another package manager operation is in progress. Please wait for it to complete.",
  className,
  isInline,
  details,
  beforeNavigate,
  onRetry,
  showRetry = false,
  signatureOrigin,
}) => {
  const { onViewKeyring } = useNavigation();
  const [lockState, setLockState] = useState<LockWaitState>("checking");
  const locked = isDbLockError(error, code);
  const signature = !locked && (code ?? parseErrorCode(error)) === "signature_error";
  const shownTitle = signature ? SIGNATURE_TITLE : locked ? LOCKED_TITLE : title;
  useFailureAnnouncement(locked || signature ? shownTitle : `${shownTitle}. ${error}`);

  if (signature) {
    return (
      <Alert
        component={headingLevel}
        variant="danger"
        title={SIGNATURE_TITLE}
        className={className}
        isInline={isInline}
        actionLinks={
          onViewKeyring && (
            <AlertActionLink
              onClick={() => {
                beforeNavigate?.();
                // A host that closes itself first cannot run its retry later.
                onViewKeyring(signatureOrigin && { ...signatureOrigin, retry: beforeNavigate ? undefined : onRetry });
              }}
            >
              Open Keyring
            </AlertActionLink>
          )
        }
      >
        <p>{error}</p>
        <p>
          The package or its signing key is not trusted by the local keyring. Refreshing keys or
          updating archlinux-keyring usually fixes this. Do not disable signature checking.
        </p>
        <ErrorDetails details={details} />
      </Alert>
    );
  }

  if (locked && onRetry) {
    return (
      <Alert
        component={headingLevel}
        variant="warning"
        title={LOCKED_TITLE}
        className={className}
        isInline={isInline}
        actionLinks={!RETRY_HIDDEN.has(lockState) && <AlertActionLink onClick={onRetry}>{RETRY_LABEL}</AlertActionLink>}
      >
        <LockErrorBody
          onRetry={onRetry}
          onAutoRetry={onRetry}
          onCleared={() => {}}
          retryKey={`${title}\n${error}`}
          retryLabel={RETRY_LABEL}
          onStateChange={setLockState}
        />
      </Alert>
    );
  }

  return (
    <Alert
        component={headingLevel}
      variant={locked ? "warning" : "danger"}
      title={shownTitle}
      className={className}
      isInline={isInline}
      actionLinks={showRetry && onRetry && <AlertActionLink onClick={onRetry}>{RETRY_LABEL}</AlertActionLink>}
    >
      {locked ? lockMessage : error}
      {!locked && <ErrorDetails details={details} />}
    </Alert>
  );
};
