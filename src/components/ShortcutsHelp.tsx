import React from "react";
import {
  Button,
  DescriptionList,
  DescriptionListDescription,
  DescriptionListGroup,
  DescriptionListTerm,
  Popover,
  Title,
} from "@patternfly/react-core";
import { KeyboardIcon } from "@patternfly/react-icons";

const SHORTCUTS: { key: string; effect: string }[] = [
  { key: "/", effect: "Go to a package or tab" },
  { key: "?", effect: "Show or hide this list" },
  { key: "Esc", effect: "Close a menu or the package details" },
  { key: "\u2191 / \u2193", effect: "Show the previous or next package while its details are open" },
];

const JUMP_VERBS: { verb: string; effect: string }[] = [
  { verb: "check", effect: "Check for updates" },
  { verb: "rank", effect: "Rank mirrors" },
  { verb: "progress", effect: "View the progress of a running transaction" },
  { verb: "reinstall <package>", effect: "Reinstall an installed package" },
  { verb: "mark <package>", effect: "Mark an installed package as dependency or explicitly installed" },
];

interface ShortcutsHelpProps {
  isOpen: boolean;
  onOpenChange: (isOpen: boolean) => void;
}

export const ShortcutsHelp: React.FC<ShortcutsHelpProps> = ({ isOpen, onOpenChange }) => (
  <Popover
    isVisible={isOpen}
    shouldOpen={() => onOpenChange(true)}
    shouldClose={() => onOpenChange(false)}
    headerContent="Keyboard shortcuts"
    position="bottom-end"
    bodyContent={
      <>
        <DescriptionList isHorizontal isCompact aria-label="Keys">
          {SHORTCUTS.map(({ key, effect }) => (
            <DescriptionListGroup key={key}>
              <DescriptionListTerm><kbd>{key}</kbd></DescriptionListTerm>
              <DescriptionListDescription>{effect}</DescriptionListDescription>
            </DescriptionListGroup>
          ))}
        </DescriptionList>
        <Title headingLevel="h3" size="md" className="pf-v6-u-mt-md pf-v6-u-mb-sm">Commands in Go to</Title>
        <DescriptionList isHorizontal isCompact aria-label="Commands in Go to">
          {JUMP_VERBS.map(({ verb, effect }) => (
            <DescriptionListGroup key={verb}>
              <DescriptionListTerm><code>{verb}</code></DescriptionListTerm>
              <DescriptionListDescription>{effect}</DescriptionListDescription>
            </DescriptionListGroup>
          ))}
        </DescriptionList>
      </>
    }
  >
    <Button variant="plain" aria-label="Keyboard shortcuts" icon={<KeyboardIcon />} />
  </Popover>
);
