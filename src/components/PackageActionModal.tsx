import React, { useState, useEffect, useCallback, useRef } from "react";
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
  EmptyState,
  EmptyStateBody,
  Label,
  Content,
  ContentVariants,
} from "@patternfly/react-core";
import { ExpandableLogViewer } from "./LogViewer";
import { ErrorAlert } from "./ErrorAlert";
import { CheckCircleIcon } from "@patternfly/react-icons";
import { installPackage, removePackage, ErrorCode, UpgradeCallbacks } from "../api";
import { appendCapped, sanitizeErrorMessage } from "../utils";

type ModalState = "confirm" | "running" | "success" | "error";

interface ActionConfig {
  verb: string;
  confirmPrompt: (pkg: string) => React.ReactNode;
  notice: React.ReactNode;
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

const PackageActionModal: React.FC<PackageActionModalProps & { config: ActionConfig }> = ({
  packageName,
  packageVersion,
  isOpen,
  onClose,
  onSuccess,
  config,
}) => {
  useBackdropClose(isOpen, onClose);
  const [state, setState] = useState<ModalState>("confirm");
  const [error, setError] = useState<string | null>(null);
  const [errorCode, setErrorCode] = useState<ErrorCode | undefined>(undefined);
  const [log, setLog] = useState("");
  const [isDetailsExpanded, setIsDetailsExpanded] = useState(false);
  const cancelRef = useRef<(() => void) | null>(null);

  const resetState = useCallback(() => {
    setState("confirm");
    setError(null);
    setErrorCode(undefined);
    setLog("");
    setIsDetailsExpanded(false);
  }, []);

  useEffect(() => {
    if (!isOpen) return;
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
    setLog("");
    setIsDetailsExpanded(true);

    const { cancel } = config.run(
      {
        onData: (data) => setLog((prev) => appendCapped(prev, data)),
        onComplete: () => {
          setState("success");
          cancelRef.current = null;
          onSuccess?.();
        },
        onError: (err, code) => {
          setState("error");
          setError(err);
          setErrorCode(code);
          cancelRef.current = null;
        },
      },
      packageName
    );
    cancelRef.current = cancel;
  };

  const handleCancel = () => {
    if (cancelRef.current) {
      cancelRef.current();
      cancelRef.current = null;
    }
    setState("confirm");
    setLog("");
  };

  const handleClose = () => {
    if (cancelRef.current) {
      cancelRef.current();
      cancelRef.current = null;
    }
    onClose();
  };

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
          </>
        );

      case "running":
        return (
          <>
            <div className="pf-v6-u-mb-md">
              <Spinner size="md" /> {config.runningText} {packageName}...
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
          <ErrorAlert error={sanitizeErrorMessage(error)} code={errorCode} title="Error" />
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
            <Button variant={config.confirmVariant} onClick={handleConfirm}>
              {config.confirmLabel}
            </Button>
            <Button variant="link" onClick={handleClose}>
              Cancel
            </Button>
          </>
        );

      case "running":
        return (
          <Button variant="danger" onClick={handleCancel}>
            Cancel
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

const installConfig: ActionConfig = {
  verb: "Install",
  confirmPrompt: (pkg) => <>Install <strong>{pkg}</strong>?</>,
  notice: (
    <Alert variant="info" title="Note" className="pf-v6-u-mt-md">
      This will install the package and its required dependencies from the repositories.
    </Alert>
  ),
  confirmLabel: "Confirm Install",
  confirmVariant: "primary",
  runningText: "Installing",
  successTitle: "Package installed",
  successText: (pkg) => `${pkg} has been installed.`,
  run: installPackage,
};

const uninstallConfig: ActionConfig = {
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

export const InstallModal: React.FC<PackageActionModalProps> = (props) => (
  <PackageActionModal {...props} config={installConfig} />
);

export const UninstallModal: React.FC<PackageActionModalProps> = (props) => (
  <PackageActionModal {...props} config={uninstallConfig} />
);
