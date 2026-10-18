import { createContext, useContext, useEffect, useRef } from "react";
import { onSystemChanged, type SystemChangeKind } from "../api";

/** Whether the enclosing tab is the visible one. Views outside any tab count as active. */
export const TabActiveContext = createContext(true);

export function useTabActive(): boolean {
  return useContext(TabActiveContext);
}

interface RefreshOptions {
  kinds?: SystemChangeKind[];
}

/**
 * Re-run `reload` when the enclosing tab becomes active, and when a matching
 * system change arrives while it is active. Not on first mount: the view's
 * own load covers that.
 */
export function useRefreshOnActivate(reload: () => void, { kinds = ["system"] }: RefreshOptions = {}): void {
  const active = useTabActive();
  const reloadRef = useRef(reload);
  const activeRef = useRef(active);
  const kindsKey = [...kinds].sort().join(",");

  useEffect(() => {
    reloadRef.current = reload;
  });

  useEffect(() => {
    const wasActive = activeRef.current;
    activeRef.current = active;
    // A change while hidden needs no bookkeeping: every activation reloads,
    // which also picks up changes made outside this page (timers, other sessions).
    if (active && !wasActive) reloadRef.current();
  }, [active]);

  useEffect(() => {
    const subscribed = kindsKey.split(",") as SystemChangeKind[];
    return onSystemChanged(() => {
      if (activeRef.current) reloadRef.current();
    }, subscribed);
  }, [kindsKey]);
}
