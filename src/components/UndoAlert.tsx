import React from "react";
import {
  Alert,
  AlertActionCloseButton,
  AlertActionLink,
  AlertGroup,
  Tooltip,
} from "@patternfly/react-core";
import type { MutationGate } from "../hooks/useMutationGate";
import { useGateTooltip } from "./GatedButton";
import type { AlertHeadingLevel } from "./ErrorAlert";

interface UndoAlertProps {
  /** Alert title; null leaves only the empty live region mounted. */
  title: string | null;
  onUndo?: () => void;
  undoLabel?: string;
  gate?: MutationGate;
  disabledReason?: string | false | null;
  onClose: () => void;
  variant?: "success" | "info";
  headingLevel?: AlertHeadingLevel;
  children?: React.ReactNode;
}

/** Undo action link that stays focusable and says why while blocked. */
export const UndoLink: React.FC<{ label: string; reason: string | undefined; onClick: () => void }> = ({ label, reason, onClick }) => {
  const tip = useGateTooltip(reason);
  return (
    <>
      <Tooltip content={tip.content} trigger="manual" isVisible={tip.isVisible} aria="none">
        <AlertActionLink
          isAriaDisabled={!!reason}
          aria-describedby={reason ? tip.id : undefined}
          onClick={() => { if (!reason) onClick(); }}
          {...tip.handlers}
        >
          {label}
        </AlertActionLink>
      </Tooltip>
      <span id={tip.id} className="pf-v6-screen-reader">{reason}</span>
    </>
  );
};

/** Mount unconditionally so the live region exists before its result appears. */
export const UndoAlert: React.FC<UndoAlertProps> = ({
  title, onUndo, undoLabel = "Undo", gate, disabledReason, onClose, variant = "success", headingLevel = "h4", children,
}) => {
  const reason = gate?.blocked ? gate.reason ?? "Unavailable" : disabledReason || undefined;
  return (
    <AlertGroup isLiveRegion>
      {title && (
        <Alert
          variant={variant}
          isInline
          component={headingLevel}
          title={title}
          className="pf-v6-u-mb-md"
          actionClose={<AlertActionCloseButton title={title} onClose={onClose} />}
          actionLinks={onUndo ? <UndoLink label={undoLabel} reason={reason} onClick={onUndo} /> : undefined}
        >
          {children}
        </Alert>
      )}
    </AlertGroup>
  );
};
