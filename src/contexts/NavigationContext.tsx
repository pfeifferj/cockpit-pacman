import React, { createContext, useContext } from "react";

export interface NavigationHandlers {
  onViewDependencies?: (packageName: string) => void;
  onViewHistory?: (packageName: string) => void;
  onViewOrphans?: () => void;
  onViewCache?: () => void;
  onViewKeyring?: () => void;
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
