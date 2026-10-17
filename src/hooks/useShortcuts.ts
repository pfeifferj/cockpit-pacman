import { useEffect, useRef, type KeyboardEvent as ReactKeyboardEvent } from "react";

type DomKeyboardEvent = ReactKeyboardEvent["nativeEvent"];

export interface ShortcutHandlers {
  onFocusJump: () => void;
  onToggleHelp: () => void;
}

// PF Popover marks itself aria-modal but closes on outside click and Escape, so it
// does not block the page the way a Modal does.
const BLOCKING_MODAL = '[aria-modal="true"]:not(.pf-v6-c-popover)';

export function shouldIgnoreShortcut(event: DomKeyboardEvent): boolean {
  if (event.defaultPrevented) return true;
  const altGraph = event.getModifierState?.("AltGraph") ?? false;
  if (!altGraph && (event.ctrlKey || event.altKey || event.metaKey)) return true;
  const target = event.target;
  if (target instanceof Element) {
    if (target.closest("input, textarea, select, [contenteditable]:not([contenteditable='false'])")) {
      return true;
    }
  }
  return document.querySelector(BLOCKING_MODAL) !== null;
}

/** Binds "/" (focus the package jump) and "?" (toggle shortcut help) on the plugin document. */
export function useShortcuts(handlers: ShortcutHandlers): void {
  const handlersRef = useRef(handlers);
  useEffect(() => {
    handlersRef.current = handlers;
  });

  useEffect(() => {
    const onKeyDown = (event: DomKeyboardEvent) => {
      if (event.key !== "/" && event.key !== "?") return;
      if (shouldIgnoreShortcut(event)) return;
      event.preventDefault();
      if (event.key === "/") {
        handlersRef.current.onFocusJump();
      } else {
        handlersRef.current.onToggleHelp();
      }
    };
    document.addEventListener("keydown", onKeyDown);
    return () => document.removeEventListener("keydown", onKeyDown);
  }, []);
}
