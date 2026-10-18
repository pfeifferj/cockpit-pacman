import React, { useEffect, useId, useRef, useState } from "react";
import { Button, DropdownItem, Tooltip, type ButtonProps, type DropdownItemProps } from "@patternfly/react-core";
import type { MutationGate } from "../hooks/useMutationGate";

interface GateProps {
  /** Mutation gate; its reason wins over disabledReason. */
  gate?: MutationGate;
  /** Local block such as "Select at least one update". */
  disabledReason?: string | false | null;
}

function blockReason({ gate, disabledReason }: GateProps): string | undefined {
  if (gate?.blocked) return gate.reason ?? "Unavailable";
  return disabledReason || undefined;
}

// The Tooltip and the reason node stay mounted whether or not the control is
// blocked, so a gate change never changes the element tree around the control
// and focus stays on it. Visibility is driven here rather than by the Tooltip's
// own triggers, which cannot hide a tooltip that was open when the trigger
// changed to "manual".
export function useGateTooltip(reason: string | undefined) {
  const [hovered, setHovered] = useState(false);
  const [focused, setFocused] = useState(false);
  const [dismissed, setDismissed] = useState(false);
  // Keeps the text while the tooltip fades out after the block lifts.
  const [lastReason, setLastReason] = useState(reason);
  if (reason && reason !== lastReason) setLastReason(reason);
  const id = useId();
  return {
    id,
    content: reason ?? lastReason ?? "",
    isVisible: !!reason && !dismissed && (hovered || focused),
    handlers: {
      onMouseEnter: () => { setHovered(true); setDismissed(false); },
      onMouseLeave: () => setHovered(false),
      onFocus: () => { setFocused(true); setDismissed(false); },
      onBlur: () => setFocused(false),
      onKeyDown: (e: React.KeyboardEvent) => { if (e.key === "Escape") setDismissed(true); },
    },
  };
}

function chain<E>(own: (e: E) => void, theirs?: (e: E) => void) {
  return (e: E) => {
    own(e);
    theirs?.(e);
  };
}

function describedBy(own: string | undefined, theirs: string | undefined): string | undefined {
  return [theirs, own].filter(Boolean).join(" ") || undefined;
}

export type GatedButtonProps = ButtonProps & GateProps & { ref?: React.Ref<React.ComponentRef<"button">> };

/**
 * Button that is aria-disabled, with a tooltip and a persistent
 * aria-describedby reason, while its gate or a local reason blocks it.
 */
export const GatedButton: React.FC<GatedButtonProps> = ({ gate, disabledReason, isAriaDisabled, ...props }) => {
  const reason = blockReason({ gate, disabledReason });
  const tip = useGateTooltip(reason);
  return (
    <>
      <Tooltip content={tip.content} trigger="manual" isVisible={tip.isVisible} aria="none">
        <Button
          {...props}
          isAriaDisabled={!!reason || isAriaDisabled}
          aria-describedby={describedBy(reason ? tip.id : undefined, props["aria-describedby"])}
          onMouseEnter={chain(tip.handlers.onMouseEnter, props.onMouseEnter)}
          onMouseLeave={chain(tip.handlers.onMouseLeave, props.onMouseLeave)}
          onFocus={chain(tip.handlers.onFocus, props.onFocus)}
          onBlur={chain(tip.handlers.onBlur, props.onBlur)}
          onKeyDown={chain(tip.handlers.onKeyDown, props.onKeyDown)}
        />
      </Tooltip>
      <span id={tip.id} className="pf-v6-screen-reader">{reason}</span>
    </>
  );
};

export type GatedDropdownItemProps = Omit<DropdownItemProps, "tooltipProps" | "actions"> & GateProps;

/** DropdownItem counterpart of GatedButton for kebab and action menus. */
export const GatedDropdownItem: React.FC<GatedDropdownItemProps> = ({ gate, disabledReason, isAriaDisabled, ...props }) => {
  const reason = blockReason({ gate, disabledReason });
  const tip = useGateTooltip(reason);
  const itemRef = useRef<React.ComponentRef<"button">>(null);
  // DropdownItem spreads extra props onto its <li>, not the menuitem element.
  useEffect(() => {
    const item = itemRef.current;
    if (!item) return;
    if (reason) item.setAttribute("aria-describedby", tip.id);
    else item.removeAttribute("aria-describedby");
  }, [reason, tip.id]);
  return (
    <DropdownItem
      {...props}
      ref={itemRef}
      isAriaDisabled={!!reason || isAriaDisabled}
      tooltipProps={{ content: tip.content, trigger: "manual", isVisible: tip.isVisible, aria: "none" }}
      actions={<span id={tip.id} className="pf-v6-screen-reader">{reason}</span>}
      {...tip.handlers}
    />
  );
};
