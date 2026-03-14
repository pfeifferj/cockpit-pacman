import React, { useState, useEffect, useCallback, useRef } from "react";
import { useBackdropClose } from "../hooks/useBackdropClose";
import { LOG_CONTAINER_HEIGHT } from "../constants";
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
  CodeBlock,
  CodeBlockCode,
  ExpandableSection,
  Content,
  ContentVariants,
} from "@patternfly/react-core";
import { CheckCircleIcon } from "@patternfly/react-icons";
import { removePackage } from "../api";
import { sanitizeErrorMessage } from "../utils";

type ModalState = "confirm" | "removing" | "success" | "error";

interface UninstallModalProps {
  packageName: string;
  packageVersion: string;
  isOpen: boolean;
  onClose: () => void;
  onSuccess?: () => void;
}

export const UninstallModal: React.FC<UninstallModalProps> = ({
  packageName,
  packageVersion,
  isOpen,
  onClose,
  onSuccess,
}) => {
  useBackdropClose(isOpen, onClose);
  const [state, setState] = useState<ModalState>("confirm");
  const [error, setError] = useState<string | null>(null);
  const [log, setLog] = useState("");
  const [isDetailsExpanded, setIsDetailsExpanded] = useState(false);
  const cancelRef = useRef<(() => void) | null>(null);
  const logContainerRef = useRef<HTMLDivElement | null>(null);

  const resetState = useCallback(() => {
    setState("confirm");
    setError(null);
    setLog("");
    setIsDetailsExpanded(false);
  }, []);

  useEffect(() => {
    if (isOpen) {
      resetState();
    }
  }, [isOpen, resetState]);

  useEffect(() => {
    return () => {
      if (cancelRef.current) {
        cancelRef.current();
      }
    };
  }, []);

  useEffect(() => {
    if (logContainerRef.current) {
      logContainerRef.current.scrollTop = logContainerRef.current.scrollHeight;
    }
  }, [log]);

  const handleConfirmRemove = () => {
    setState("removing");
    setLog("");
    setIsDetailsExpanded(true);

    const { cancel } = removePackage(
      {
        onData: (data) => setLog((prev) => prev + data),
        onComplete: () => {
          setState("success");
          cancelRef.current = null;
          onSuccess?.();
        },
        onError: (err) => {
          setState("error");
          setError(err);
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
                Are you sure you want to uninstall <strong>{packageName}</strong>?
              </Content>
              <Content component={ContentVariants.p} className="pf-v6-u-mt-md">
                <Label color="blue">{packageVersion}</Label>
              </Content>
            </Content>
            <Alert variant="warning" title="Warning" className="pf-v6-u-mt-md">
              Removing a package will also remove its orphaned dependencies.
              If other installed packages depend on this one, the removal will be blocked.
            </Alert>
          </>
        );

      case "removing":
        return (
          <>
            <div className="pf-v6-u-mb-md">
              <Spinner size="md" /> Removing {packageName}...
            </div>
            <ExpandableSection
              toggleText={isDetailsExpanded ? "Hide details" : "Show details"}
              onToggle={(_event, expanded) => setIsDetailsExpanded(expanded)}
              isExpanded={isDetailsExpanded}
            >
              <div ref={logContainerRef} style={{ maxHeight: LOG_CONTAINER_HEIGHT, overflow: "auto" }}>
                <CodeBlock>
                  <CodeBlockCode>{log || "Starting..."}</CodeBlockCode>
                </CodeBlock>
              </div>
            </ExpandableSection>
          </>
        );

      case "success":
        return (
          <EmptyState headingLevel="h3" icon={CheckCircleIcon} titleText="Package removed">
            <EmptyStateBody>
              {packageName} has been uninstalled.
            </EmptyStateBody>
          </EmptyState>
        );

      case "error":
        return (
          <Alert variant="danger" title="Error">
            {sanitizeErrorMessage(error)}
          </Alert>
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
            <Button variant="danger" onClick={handleConfirmRemove}>
              Confirm Uninstall
            </Button>
            <Button variant="link" onClick={handleClose}>
              Cancel
            </Button>
          </>
        );

      case "removing":
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
      <ModalHeader title={`Uninstall ${packageName}`} />
      <ModalBody>{renderContent()}</ModalBody>
      <ModalFooter>{renderFooter()}</ModalFooter>
    </Modal>
  );
};
