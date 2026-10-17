import React, { useId } from "react";
import { Modal, ModalVariant, ModalHeader, ModalBody, ModalFooter } from "@patternfly/react-core";
import { useBackdropClose } from "../hooks/useBackdropClose";
import { usePackageDetailsPanel, type PackageDetailsPanelProps } from "./PackageDetailsPanel";

export { optdepName } from "./PackageDetailsPanel";

/** Package details in a modal dialog. */
export const PackageDetailsModal: React.FC<PackageDetailsPanelProps> = (props) => {
  const titleId = useId();
  const modalId = useId();
  const parts = usePackageDetailsPanel(props, {
    hidesUnderChild: true,
    headingLevel: "h2",
    // Inside the focus trap but outside the scrolling modal box, so the menu is neither clipped nor unreachable.
    menuAppendTo: () => document.getElementById(modalId)?.closest<HTMLElement>(".pf-v6-l-bullseye") ?? document.body,
  });
  useBackdropClose(parts.isShown, props.onClose);

  return (
    <>
      <Modal
        id={modalId}
        variant={ModalVariant.medium}
        isOpen={parts.isShown}
        onClose={parts.close}
        onEscapePress={parts.inOptdep ? parts.back : undefined}
        aria-labelledby={titleId}
        data-details-for={parts.name}
      >
        <ModalHeader labelId={titleId} title={parts.title} />
        <ModalBody aria-busy={parts.isBusy || undefined}>{parts.body}{parts.notices}</ModalBody>
        {parts.footer && <ModalFooter>{parts.footer}</ModalFooter>}
      </Modal>
      {parts.overlays}
    </>
  );
};
