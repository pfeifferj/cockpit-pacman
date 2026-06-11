import React from "react";
import { Alert } from "@patternfly/react-core";
import { isDbLockError } from "../utils";
import type { ErrorCode } from "../api";

interface ErrorAlertProps {
  error: string;
  code?: ErrorCode;
  title: string;
  lockMessage?: string;
  className?: string;
}

/** Error alert that downgrades to a warning when pacman's database is locked. */
export const ErrorAlert: React.FC<ErrorAlertProps> = ({
  error,
  code,
  title,
  lockMessage = "Another package manager operation is in progress. Please wait for it to complete.",
  className,
}) => {
  const locked = isDbLockError(error, code);
  return (
    <Alert
      variant={locked ? "warning" : "danger"}
      title={locked ? "Database is locked" : title}
      className={className}
    >
      {locked ? lockMessage : error}
    </Alert>
  );
};
