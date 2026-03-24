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
import { installPackage } from "../api";
import { sanitizeErrorMessage } from "../utils";

type ModalState = "confirm" | "installing" | "success" | "error";

interface InstallModalProps {
  packageName: string;
  packageVersion: string;
  isOpen: boolean;
  onClose: () => void;
  onSuccess?: () => void;
}

export const InstallModal: React.FC<InstallModalProps> = ({
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

  const handleConfirmInstall = () => {
    setState("installing");
    setLog("");
    setIsDetailsExpanded(true);

    const { cancel } = installPackage(
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
                Install <strong>{packageName}</strong>?
              </Content>
              <Content component={ContentVariants.p} className="pf-v6-u-mt-md">
                <Label isCompact variant="outline">{packageVersion}</Label>
              </Content>
            </Content>
            <Alert variant="info" title="Note" className="pf-v6-u-mt-md">
              This will install the package and its required dependencies from the repositories.
            </Alert>
          </>
        );

      case "installing":
        return (
          <>
            <div className="pf-v6-u-mb-md">
              <Spinner size="md" /> Installing {packageName}...
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
          <EmptyState headingLevel="h3" icon={CheckCircleIcon} titleText="Package installed">
            <EmptyStateBody>
              {packageName} has been installed.
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
            <Button variant="primary" onClick={handleConfirmInstall}>
              Confirm Install
            </Button>
            <Button variant="link" onClick={handleClose}>
              Cancel
            </Button>
          </>
        );

      case "installing":
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
      <ModalHeader title={`Install ${packageName}`} />
      <ModalBody>{renderContent()}</ModalBody>
      <ModalFooter>{renderFooter()}</ModalFooter>
    </Modal>
  );
};
