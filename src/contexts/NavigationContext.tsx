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

export interface NavigationHandlers {
  onViewUpdates?: () => void;
  onViewDependencies?: (packageName: string) => void;
  onViewHistory?: (packageName: string) => void;
  onViewOrphans?: () => void;
  onViewCache?: () => void;
  onViewKeyring?: (context?: KeyringContext) => void;
  onViewSignoffs?: () => void;
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
