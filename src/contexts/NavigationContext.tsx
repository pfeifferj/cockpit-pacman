import React, { createContext, useContext } from "react";

/** What failed on a signature error, so the Keyring tab can offer the way back. */
export interface KeyringContext {
  origin: "upgrade" | "install";
  target?: string;
  /** Packages the failed operation covered, for a scoped retry label. */
  count?: number;
  /** Re-runs the failed operation from its preview; absent when its host has closed. */
  retry?: () => void;
}

/** A disk-space block's shortfall, so the Cache tab can show what is left to free and lead back. */
export interface CacheContext {
  deficit: number;
  mount: string;
  /** Update names the blocked upgrade covered. */
  selection?: string[];
  /** Reruns the blocked upgrade's preview for `selection`; absent when its host has closed. */
  resume?: () => void;
}

export interface NavigationHandlers {
  onViewUpdates?: () => void;
  onViewDependencies?: (packageName: string) => void;
  onViewHistory?: (packageName: string) => void;
  onViewOrphans?: () => void;
  onViewCache?: (context?: CacheContext) => void;
  onViewKeyring?: (context?: KeyringContext) => void;
  /** Opens Signoffs; `filter` is the route form of a filter set, such as SIGNOFF_TILE_FILTER. */
  onViewSignoffs?: (filter?: string) => void;
}

const NavigationContext = createContext<NavigationHandlers>({});

export const NavigationProvider: React.FC<{
  value: NavigationHandlers;
  children: React.ReactNode;
}> = ({ value, children }) => (
  <NavigationContext.Provider value={value}>{children}</NavigationContext.Provider>
);

export function useNavigation(): NavigationHandlers {
  return useContext(NavigationContext);
}
