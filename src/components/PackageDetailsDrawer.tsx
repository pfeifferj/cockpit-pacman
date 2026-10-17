import React, { useCallback, useEffect, useId, useLayoutEffect, useRef, useSyncExternalStore } from "react";
import {
  Drawer,
  DrawerActions,
  DrawerCloseButton,
  DrawerContent,
  DrawerContentBody,
  DrawerHead,
  DrawerPanelBody,
  DrawerPanelContent,
  Flex,
  Title,
} from "@patternfly/react-core";
import { usePackageDetailsPanel, type PackageDetailsPanelProps } from "./PackageDetailsPanel";
import { useAnnounce } from "../contexts/AnnouncerContext";
import { rememberRow, restoreRowFocus, type RowMemo } from "../rowFocus";

// PF's xl breakpoint; narrower layouts overlay the list.
const INLINE_QUERY = "(min-width: 1200px)";

/** Marks a row's name button as the trigger that focus returns to when the panel closes. */
export const DETAILS_TRIGGER_ATTR = "data-details-trigger";

const OPEN_ROW_STYLE: React.CSSProperties = {
  outline: "var(--pf-t--global--border--width--strong) solid var(--pf-t--global--border--color--clicked)",
  outlineOffset: "calc(var(--pf-t--global--border--width--strong) * -1)",
};

export function detailsRowProps(isOpen: boolean): { "aria-current"?: true; style?: React.CSSProperties } {
  return isOpen ? { "aria-current": true, style: OPEN_ROW_STYLE } : {};
}

// Escape typed here edits text or closes the control's own popup.
const OWNS_ESCAPE = 'input, textarea, select, [contenteditable="true"], [role="menu"], [role="listbox"], [role="dialog"], .pf-v6-c-menu, .pf-v6-c-popover';

function useMediaQuery(query: string): boolean {
  const subscribe = useCallback((onChange: () => void) => {
    const mql = typeof window.matchMedia === "function" ? window.matchMedia(query) : undefined;
    mql?.addEventListener?.("change", onChange);
    return () => mql?.removeEventListener?.("change", onChange);
  }, [query]);
  return useSyncExternalStore(subscribe, () =>
    typeof window.matchMedia === "function" ? !!window.matchMedia(query)?.matches : true);
}

/** Whether a PackageDetailsDrawer shows its panel beside the content (true) or over it. */
export function useDetailsInline(): boolean {
  return useMediaQuery(INLINE_QUERY);
}

interface PackageDetailsDrawerProps extends PackageDetailsPanelProps {
  /** Key of the row whose details are shown; its DETAILS_TRIGGER_ATTR button gets focus back on close. */
  activeKey: string | null;
  children: React.ReactNode;
}

/** Responsive package details beside or over a list. */
export const PackageDetailsDrawer: React.FC<PackageDetailsDrawerProps> = ({ activeKey, children, ...panelProps }) => {
  const isInline = useDetailsInline();
  const titleId = useId();
  const wrapperRef = useRef<HTMLDivElement>(null);
  const contentRef = useRef<HTMLDivElement>(null);
  const announce = useAnnounce();

  // Rows inside collapsed sections stay mounted but hidden; they cannot take focus.
  const triggers = () => Array.from(contentRef.current?.querySelectorAll<HTMLElement>(`[${DETAILS_TRIGGER_ATTR}]`) ?? [])
    .filter((el) => !el.closest("[hidden]"));

  const activeTrigger = () => activeKey === null ? undefined
    : triggers().find((el) => el.getAttribute(DETAILS_TRIGGER_ATTR) === activeKey);

  const rowMemo = useRef<RowMemo | null>(null);
  const cancelRestore = useRef<() => void>(() => {});
  useEffect(() => () => cancelRestore.current(), []);

  const returnFocus = () => {
    if (activeKey === null) return;
    const trigger = activeTrigger();
    if (trigger) {
      trigger.focus();
      return;
    }
    const memo = rowMemo.current;
    if (!memo || memo.key !== activeKey) return;
    const name = parts.name ?? activeKey;
    cancelRestore.current();
    cancelRestore.current = restoreRowFocus(memo, () => announce(`${name} is no longer in the list`));
  };

  const closeRef = useRef<() => void>(() => {});
  const parts = usePackageDetailsPanel(panelProps, {
    hidesUnderChild: false,
    headingLevel: "h3",
    menuAppendTo: () => document.body,
    actionsAtTop: true,
    onUserClose: () => closeRef.current(),
  });
  const expanded = parts.isRequested;

  useEffect(() => {
    if (!expanded) return;
    const trigger = activeTrigger();
    if (trigger) rowMemo.current = rememberRow(trigger, `[${DETAILS_TRIGGER_ATTR}]`, DETAILS_TRIGGER_ATTR);
  });

  const closeByUser = () => {
    returnFocus();
    parts.close();
  };
  useEffect(() => {
    closeRef.current = closeByUser;
  });

  // The title mounts after the panel expands; defer focus until it exists.
  const pendingFocus = useRef(false);
  const titleRef = useRef<React.ComponentRef<"h2"> | null>(null);
  const preventScrollRef = useRef(isInline);
  useEffect(() => {
    preventScrollRef.current = isInline;
  });
  const setTitle = useCallback((el: React.ComponentRef<"h2"> | null) => {
    titleRef.current = el;
    if (el && pendingFocus.current) {
      pendingFocus.current = false;
      el.focus({ preventScroll: preventScrollRef.current });
    }
  }, []);
  const wasExpanded = useRef(expanded);
  useEffect(() => {
    const opened = expanded && !wasExpanded.current;
    wasExpanded.current = expanded;
    pendingFocus.current = false;
    if (!opened || !contentRef.current?.contains(document.activeElement)) return;
    if (titleRef.current) {
      titleRef.current.focus({ preventScroll: preventScrollRef.current });
    } else {
      pendingFocus.current = true;
    }
  }, [expanded]);

  const shownName = expanded ? parts.name : undefined;
  const lastShown = useRef(shownName);
  useLayoutEffect(() => {
    const previous = lastShown.current;
    lastShown.current = shownName;
    if (!shownName || !previous || shownName === previous) return;
    const panel = wrapperRef.current?.querySelector<HTMLElement>(".pf-v6-c-drawer__panel");
    if (panel) panel.scrollTop = 0;
    announce(`Details: ${shownName}`);
  }, [shownName, announce]);

  // Sticky positioning requires clip instead of PF drawer overflow: hidden.
  useLayoutEffect(() => {
    const main = wrapperRef.current?.querySelector<HTMLElement>(".pf-v6-c-drawer__main");
    if (!main) return;
    main.style.overflow = isInline ? "clip" : "";
  }, [isInline]);

  const onKeyDown = (event: React.KeyboardEvent) => {
    if (!expanded || event.defaultPrevented || event.altKey || event.ctrlKey || event.metaKey) return;
    const target = event.target as HTMLElement;
    if (event.key === "Escape") {
      // The overlay panel is itself a dialog; Escape inside it still closes it.
      const owner = target.closest(OWNS_ESCAPE);
      if (owner && !owner.classList.contains("pf-v6-c-drawer__panel")) return;
      event.preventDefault();
      if (parts.inOptdep) {
        parts.back();
      } else {
        closeByUser();
      }
      return;
    }
    if ((event.key === "ArrowDown" || event.key === "ArrowUp") && target.hasAttribute(DETAILS_TRIGGER_ATTR)
      && contentRef.current?.contains(target)) {
      const rows = triggers();
      const next = rows[rows.indexOf(target) + (event.key === "ArrowDown" ? 1 : -1)];
      event.preventDefault();
      if (!next) return;
      next.focus();
      next.click();
    }
  };

  const panel = (
    <DrawerPanelContent
      widths={{ default: "width_100", lg: "width_75", xl: "width_33" }}
      // Overlaid, PF's focus trap makes the panel a modal dialog; an explicit role would override it.
      {...(isInline ? { role: "region" } : {})}
      aria-labelledby={titleId}
      aria-busy={parts.isBusy || undefined}
      data-details-for={parts.name}
      focusTrap={expanded && !isInline ? { enabled: true, "aria-labelledby": titleId } : undefined}
      style={isInline ? { position: "sticky", top: 0, alignSelf: "flex-start", maxHeight: "100vh" } : undefined}
    >
      {expanded && (
        <>
          <DrawerHead>
            <div>
              <Title headingLevel="h2" size="xl" id={titleId} ref={setTitle} tabIndex={-1}>
                {parts.title}
              </Title>
              {parts.footer && (
                <Flex className="pf-v6-u-mt-md" alignItems={{ default: "alignItemsCenter" }} gap={{ default: "gapSm" }}>
                  {parts.footer}
                </Flex>
              )}
              {parts.notices}
            </div>
            <DrawerActions>
              <DrawerCloseButton onClose={closeByUser} aria-label="Close package details" />
            </DrawerActions>
          </DrawerHead>
          <DrawerPanelBody>
            {parts.body}
          </DrawerPanelBody>
        </>
      )}
    </DrawerPanelContent>
  );

  return (
    <>
      <div ref={wrapperRef} onKeyDown={onKeyDown}>
        <Drawer isExpanded={expanded} isInline={isInline} position="end" style={isInline ? { overflowX: "clip" } : undefined}>
          <DrawerContent panelContent={panel} colorVariant="primary">
            <DrawerContentBody>
              <div ref={contentRef}>{children}</div>
            </DrawerContentBody>
          </DrawerContent>
        </Drawer>
      </div>
      {parts.overlays}
    </>
  );
};
