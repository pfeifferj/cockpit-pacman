import React from "react";
import {
  Button,
  EmptyState,
  EmptyStateActions,
  EmptyStateBody,
  EmptyStateFooter,
} from "@patternfly/react-core";
import { DisconnectedIcon } from "@patternfly/react-icons";
import { ARCH_STATUS_URL } from "../constants";

interface NetworkErrorStateProps {
  /** What couldn't be loaded, e.g. "updates", "mirror status". */
  resource?: string;
  onRetry?: () => void;
  onDismiss?: () => void;
  headingLevel?: "h1" | "h2" | "h3" | "h4";
}

/**
 * Unified empty state for connectivity failures reaching Arch Linux services.
 * Network calls run on the managed host, so this means the host is offline or
 * the upstream service is down, not the browser.
 */
export const NetworkErrorState: React.FunctionComponent<NetworkErrorStateProps> = ({
  resource,
  onRetry,
  onDismiss,
  headingLevel = "h2",
}) => (
  <EmptyState
    headingLevel={headingLevel}
    icon={DisconnectedIcon}
    titleText="Can't reach Arch Linux services"
    status="warning"
  >
    <EmptyStateBody>
      {resource ? `Couldn't load ${resource}. ` : null}
      Check the host&apos;s network connection or the{" "}
      <a href={ARCH_STATUS_URL} target="_blank" rel="noopener noreferrer">
        Arch Linux status page
      </a>
      .
    </EmptyStateBody>
    {(onRetry || onDismiss) && (
      <EmptyStateFooter>
        <EmptyStateActions>
          {onRetry && (
            <Button variant="primary" onClick={onRetry}>
              Retry
            </Button>
          )}
          {onDismiss && (
            <Button variant="link" onClick={onDismiss}>
              Dismiss
            </Button>
          )}
        </EmptyStateActions>
      </EmptyStateFooter>
    )}
  </EmptyState>
);
