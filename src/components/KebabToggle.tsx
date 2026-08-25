import React from "react";
import { MenuToggle, MenuToggleElement } from "@patternfly/react-core";
import { EllipsisVIcon } from "@patternfly/react-icons";

export function kebabToggle(ariaLabel: string, isExpanded: boolean, onClick: () => void) {
  return function KebabToggle(toggleRef: React.Ref<MenuToggleElement>) {
    return (
      <MenuToggle
        ref={toggleRef}
        variant="plain"
        aria-label={ariaLabel}
        isExpanded={isExpanded}
        onClick={onClick}
      >
        <EllipsisVIcon />
      </MenuToggle>
    );
  };
}
