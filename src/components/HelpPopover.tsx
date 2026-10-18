import React from "react";
import { Button, Popover } from "@patternfly/react-core";
import { OutlinedQuestionCircleIcon } from "@patternfly/react-icons";
import type { ThProps } from "@patternfly/react-table";

export interface HelpPopoverProps {
  header?: React.ReactNode;
  body: React.ReactNode;
  /** Names the trigger "More information about <label>". */
  label: string;
}

const stopClick = (e: React.MouseEvent) => e.stopPropagation();
const stopActivationKey = (e: React.KeyboardEvent) => {
  if (e.key === "Enter" || e.key === " ") e.stopPropagation();
};

/**
 * Focusable help trigger. Propagation is stopped so a trigger inside a
 * sortable Th, a clickable Tr or a toggle does not also activate its host.
 */
export const HelpPopover: React.FC<HelpPopoverProps> = ({ header, body, label }) => (
  <Popover headerContent={header} bodyContent={body}>
    <Button
      variant="plain"
      hasNoPadding
      aria-label={`More information about ${label}`}
      icon={<OutlinedQuestionCircleIcon />}
      onClick={stopClick}
      onKeyDown={stopActivationKey}
    />
  </Popover>
);

/**
 * Th `info` prop for column help. PF renders the trigger beside the sort
 * button rather than inside it, which avoids nesting buttons.
 */
export function helpInfo(label: string, body: React.ReactNode, header?: React.ReactNode): NonNullable<ThProps["info"]> {
  return {
    popover: body,
    popoverProps: header ? { headerContent: header } : undefined,
    ariaLabel: `More information about ${label}`,
  };
}
