import React, { useState, useEffect, useCallback, useRef } from "react";
import { useStreamingLog } from "../hooks/useStreamingLog";
import { useBackdropClose } from "../hooks/useBackdropClose";
import {
  Modal,
  ModalVariant,
  ModalHeader,
  ModalBody,
  ModalFooter,
  Button,
  Spinner,
  Alert,
  AlertActionLink,
  EmptyState,
  EmptyStateBody,
  Label,
  Content,
  ContentVariants,
} from "@patternfly/react-core";
import { ExpandableLogViewer } from "./LogViewer";
import { ErrorAlert } from "./ErrorAlert";
import { CheckCircleIcon } from "@patternfly/react-icons";
import { checkUpdates, installPackage, removePackage, ErrorCode, UpgradeCallbacks } from "../api";
import { sanitizeErrorMessage } from "../utils";
import { useNavigation } from "../contexts/NavigationContext";

type ModalState = "confirm" | "running" | "success" | "error";

interface ActionConfig {
  verb: string;
  confirmPrompt: (pkg: string) => React.ReactNode;
  notice: React.ReactNode;
  warnPendingUpdates?: boolean;
  confirmLabel: string;
  confirmVariant: "primary" | "danger";
  runningText: string;
  successTitle: string;
  successText: (pkg: string) => string;
  run: (callbacks: UpgradeCallbacks, name: string) => { cancel: () => void };
}

interface PackageActionModalProps {
  packageName: string;
  packageVersion: string;
  isOpen: boolean;
  onClose: () => void;
  onSuccess?: () => void;
}

export const PackageActionModal: React.FC<PackageActionModalProps & { config: ActionConfig }> = ({
  packageName,
  packageVersion,
  isOpen,
  onClose,
  onSuccess,
  config,
}) => {
  const { onViewUpdates } = useNavigation();
  const [state, setState] = useState<ModalState>("confirm");
  const [error, setError] = useState<string | null>(null);
  const [errorCode, setErrorCode] = useState<ErrorCode | undefined>(undefined);
  const { log, appendLog, flushLog, resetLog } = useStreamingLog();
  const [isCancelling, setIsCancelling] = useState(false);
  const cancellingRef = useRef(false);
  const [errorDetails, setErrorDetails] = useState<string | undefined>();
  const [isDetailsExpanded, setIsDetailsExpanded] = useState(false);
  const [updateCheck, setUpdateCheck] = useState<{ count: number } | { error: string } | null>(null);
  const pendingUpdates = updateCheck && "count" in updateCheck ? updateCheck.count : null;
  const checkingUpdates = !!config.warnPendingUpdates && updateCheck === null;
  const cancelRef = useRef<(() => void) | null>(null);

  useEffect(() => {
    if (!isOpen || !config.warnPendingUpdates) return;
    let stale = false;
    checkUpdates()
      .then((response) => {
        if (!stale) setUpdateCheck({ count: response.updates.length });
      })
      .catch((err: unknown) => {
        if (!stale) setUpdateCheck({ error: err instanceof Error ? err.message : String(err) });
      });
    return () => {
      stale = true;
      setUpdateCheck(null);
    };
  }, [isOpen, config.warnPendingUpdates, packageName]);

  const resetState = useCallback(() => {
    setState("confirm");
    setError(null);
    setErrorCode(undefined);
    setErrorDetails(undefined);
    resetLog();
    setIsDetailsExpanded(false);
  }, [resetLog]);

  useEffect(() => {
    if (!isOpen || cancelRef.current) return;
    Promise.resolve().then(resetState);
  }, [isOpen, resetState]);

  useEffect(() => {
    return () => {
      if (cancelRef.current) {
        cancelRef.current();
      }
    };
  }, []);

  const handleConfirm = () => {
    setState("running");
    resetLog();
    setIsDetailsExpanded(true);

    const { cancel } = config.run(
      {
        onData: appendLog,
        onComplete: () => {
          flushLog();
          setIsCancelling(false);
          cancellingRef.current = false;
          setState("success");
          cancelRef.current = null;
          onSuccess?.();
        },
        onError: (err, code, details) => {
          flushLog();
          setIsCancelling(false);
          cancellingRef.current = false;
          setState("error");
          setError(err);
          setErrorDetails(details);
          setErrorCode(code);
          cancelRef.current = null;
        },
      },
      packageName
    );
    cancelRef.current = cancel;
  };

  const handleCancel = () => {
    if (!cancelRef.current || cancellingRef.current) return;
    cancellingRef.current = true;
    setIsCancelling(true);
    cancelRef.current();
  };

  const handleClose = () => {
    if (cancelRef.current) {
      handleCancel();
      return;
    }
    onClose();
  };
  useBackdropClose(isOpen, handleClose);

  const renderContent = () => {
    switch (state) {
      case "confirm":
        return (
          <>
            <Content>
              <Content component={ContentVariants.p}>
                {config.confirmPrompt(packageName)}
              </Content>
              <Content component={ContentVariants.p} className="pf-v6-u-mt-md">
                <Label isCompact variant="outline">{packageVersion}</Label>
              </Content>
            </Content>
            {config.notice}
            {config.warnPendingUpdates && updateCheck && "error" in updateCheck && (
              <Alert
                variant="warning"
                isLiveRegion
                title="Could not check for pending updates"
                className="pf-v6-u-mt-md"
              >
                {sanitizeErrorMessage(updateCheck.error)}
              </Alert>
            )}
            {config.warnPendingUpdates && pendingUpdates !== null && pendingUpdates > 0 && (
              <Alert
                variant="warning"
                isLiveRegion
                title={`${pendingUpdates} system update${pendingUpdates !== 1 ? "s" : ""} pending`}
                className="pf-v6-u-mt-md"
                actionLinks={
                  onViewUpdates && (
                    <AlertActionLink
                      onClick={() => {
                        onViewUpdates();
                        handleClose();
                      }}
                    >
                      Review updates
                    </AlertActionLink>
                  )
                }
              >
                Installing packages before a full system upgrade can cause a partial upgrade.
                Upgrade the system first to avoid incompatible package versions.
              </Alert>
            )}
          </>
        );

      case "running":
        return (
          <>
            <div className="pf-v6-u-mb-md">
              <Spinner size="md" /> {isCancelling ? "Cancellation requested. Waiting for the operation to finish safely." : <>{config.runningText} {packageName}...</>}
            </div>
            <ExpandableLogViewer
              log={log}
              placeholder="Starting..."
              isExpanded={isDetailsExpanded}
              onToggle={setIsDetailsExpanded}
            />
          </>
        );

      case "success":
        return (
          <EmptyState headingLevel="h3" icon={CheckCircleIcon} titleText={config.successTitle}>
            <EmptyStateBody>
              {config.successText(packageName)}
            </EmptyStateBody>
          </EmptyState>
        );

      case "error":
        return (
          <>
            <ErrorAlert error={sanitizeErrorMessage(error)} code={errorCode} details={errorDetails} title="Error" />
            {log && <ExpandableLogViewer log={log} isExpanded={isDetailsExpanded} onToggle={setIsDetailsExpanded} />}
          </>
        );

      default:
        return null;
    }
  };

  const renderFooter = () => {
    switch (state) {
      case "confirm":
        return (
          <>
            <Button
              variant={config.confirmVariant}
              onClick={handleConfirm}
              isDisabled={checkingUpdates}
              isLoading={checkingUpdates}
            >
              {config.confirmLabel}
            </Button>
            <Button variant="link" onClick={handleClose}>
              Cancel
            </Button>
          </>
        );

      case "running":
        return (
          <Button variant="danger" onClick={handleCancel} isDisabled={isCancelling}>
            {isCancelling ? "Cancellation requested" : "Cancel"}
          </Button>
        );

      case "success":
        return (
          <Button variant="primary" onClick={handleClose}>
            Close
          </Button>
        );

      case "error":
        return (
          <>
            <Button variant="primary" onClick={resetState}>
              Retry
            </Button>
            <Button variant="link" onClick={handleClose}>
              Close
            </Button>
          </>
        );

      default:
        return null;
    }
  };

  return (
    <Modal
      variant={ModalVariant.small}
      isOpen={isOpen}
      onClose={handleClose}
    >
      <ModalHeader title={`${config.verb} ${packageName}`} />
      <ModalBody>{renderContent()}</ModalBody>
      <ModalFooter>{renderFooter()}</ModalFooter>
    </Modal>
  );
};

export const installConfig: ActionConfig = {
  verb: "Install",
  confirmPrompt: (pkg) => <>Install <strong>{pkg}</strong>?</>,
  notice: (
    <Alert variant="info" title="Note" className="pf-v6-u-mt-md">
      This will install the package and its required dependencies from the repositories.
    </Alert>
  ),
  warnPendingUpdates: true,
  confirmLabel: "Confirm Install",
  confirmVariant: "primary",
  runningText: "Installing",
  successTitle: "Package installed",
  successText: (pkg) => `${pkg} has been installed.`,
  run: installPackage,
};

export const uninstallConfig: ActionConfig = {
  verb: "Uninstall",
  confirmPrompt: (pkg) => <>Are you sure you want to uninstall <strong>{pkg}</strong>?</>,
  notice: (
    <Alert variant="warning" title="Warning" className="pf-v6-u-mt-md">
      Removing a package will also remove its orphaned dependencies.
      If other installed packages depend on this one, the removal will be blocked.
    </Alert>
  ),
  confirmLabel: "Confirm Uninstall",
  confirmVariant: "danger",
  runningText: "Removing",
  successTitle: "Package removed",
  successText: (pkg) => `${pkg} has been uninstalled.`,
  run: removePackage,
};
