import React, { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from "react";
import { DowngradeModal } from "../components/DowngradeModal";

interface DowngradeTarget {
  readonly name: string;
  readonly version: string;
  readonly preselectVersion?: string;
}

interface DowngradeControls {
  isOpen: boolean;
  open: (target: DowngradeTarget) => void;
}

const DowngradeContext = createContext<DowngradeControls | null>(null);

export const DowngradeProvider: React.FC<{ children: React.ReactNode }> = ({ children }) => {
  const [target, setTarget] = useState<DowngradeTarget | null>(null);
  const restoreFocusRef = useRef(false);
  const open = useCallback(({ name, version, preselectVersion }: DowngradeTarget) => {
    setTarget((current) => current ?? { name, version, preselectVersion });
  }, []);
  const close = useCallback(() => {
    restoreFocusRef.current = true;
    setTarget(null);
  }, []);
  useEffect(() => {
    if (target || !restoreFocusRef.current) return;
    restoreFocusRef.current = false;
    // The details trigger is gone; let another dialog or background handoff claim focus first.
    const timeout = setTimeout(() => {
      if (document.activeElement !== document.body || document.querySelector('[role="dialog"]')) return;
      document.querySelector<HTMLElement>('[role="tabpanel"]:not([hidden])')?.focus();
    }, 0);
    return () => clearTimeout(timeout);
  }, [target]);
  const value = useMemo(() => ({ isOpen: target !== null, open }), [target, open]);

  return (
    <DowngradeContext.Provider value={value}>
      {children}
      {target && (
        <DowngradeModal
          packageName={target.name}
          currentVersion={target.version}
          preselectVersion={target.preselectVersion}
          isOpen
          onClose={close}
        />
      )}
    </DowngradeContext.Provider>
  );
};

export function useDowngrade(): DowngradeControls | null {
  return useContext(DowngradeContext);
}
