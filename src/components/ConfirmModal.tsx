import React, { useId } from "react";
import { Button, Modal, ModalBody, ModalFooter, ModalHeader, ModalVariant } from "@patternfly/react-core";
import type { MutationGate } from "../hooks/useMutationGate";
import { GatedButton } from "./GatedButton";

export type ConfirmSeverity = "info" | "warning" | "danger";

export interface ConfirmModalProps {
  isOpen: boolean;
  title: string;
  /** info: no title icon, primary commit. warning: warning icon, primary commit. danger: danger icon and commit. */
  severity?: ConfirmSeverity;
  commitLabel: React.ReactNode;
  onConfirm: () => void;
  onClose: () => void;
  cancelLabel?: string;
  commitDisabled?: boolean;
  /** Blocks the commit, keeping it focusable with this reason; preferred over commitDisabled. */
  disabledReason?: string | false | null;
  /** Blocks the commit with a reason while another transaction runs. */
  gate?: MutationGate;
  commitLoading?: boolean;
  /** Disables Cancel too, for a commit that is already under way. */
  busy?: boolean;
  /** Overrides the commit variant chosen by severity. */
  commitVariant?: "primary" | "danger";
  children?: React.ReactNode;
}

/** Small confirm dialog whose accessible name is always its title. */
export const ConfirmModal: React.FC<ConfirmModalProps> = ({
  isOpen,
  title,
  severity = "info",
  commitLabel,
  onConfirm,
  onClose,
  cancelLabel = "Cancel",
  commitDisabled,
  disabledReason,
  gate,
  commitLoading,
  busy,
  commitVariant,
  children,
}) => {
  const titleId = useId();
  return (
    <Modal variant={ModalVariant.small} isOpen={isOpen} onClose={onClose} aria-labelledby={titleId}>
      <ModalHeader
        title={title}
        labelId={titleId}
        titleIconVariant={severity === "info" ? undefined : severity}
      />
      {children && <ModalBody>{children}</ModalBody>}
      <ModalFooter>
        <GatedButton
          gate={gate}
          disabledReason={disabledReason}
          variant={commitVariant ?? (severity === "danger" ? "danger" : "primary")}
          onClick={onConfirm}
          isDisabled={commitDisabled || busy}
          isLoading={commitLoading}
        >
          {commitLabel}
        </GatedButton>
        <Button variant="link" onClick={onClose} isDisabled={busy}>
          {cancelLabel}
        </Button>
      </ModalFooter>
    </Modal>
  );
};
