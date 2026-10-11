import { useState, useMemo, useCallback, useRef } from "react";
import { PackageSecurityAdvisory, checkSecurity, getSettings, setSecurityAdvisories } from "../api";
import { partitionAdvisories } from "../security";

export function useSecurityAdvisories(): {
  advisories: Map<string, PackageSecurityAdvisory[]>;
  actionable: Map<string, PackageSecurityAdvisory[]>;
  loading: boolean;
  stale: boolean;
  unavailable: boolean;
  loadError: string | null;
  enabled: boolean | null;
  toggleBusy: boolean;
  toggleError: string | null;
  clearToggleError: () => void;
  load: (force?: boolean) => Promise<void>;
  setEnabled: (enabled: boolean) => Promise<void>;
} {
  const [advisories, setAdvisories] = useState<Map<string, PackageSecurityAdvisory[]>>(new Map());
  const [loading, setLoading] = useState(true);
  const [stale, setStale] = useState(false);
  const [enabled, setEnabledState] = useState<boolean | null>(null);
  const [toggleBusy, setToggleBusy] = useState(false);
  const [toggleError, setToggleError] = useState<string | null>(null);
  const [unavailable, setUnavailable] = useState(false);
  const [loadError, setLoadError] = useState<string | null>(null);
  const sequence = useRef(0);
  const writing = useRef(false);

  const load = useCallback(async (force = false) => {
    if (writing.current) return;
    const request = ++sequence.current;
    setLoading(true);
    setLoadError(null);
    let settingsKnown = false;
    try {
      const settings = await getSettings();
      if (request !== sequence.current) return;
      setEnabledState(settings.security_advisories);
      if (settings.security_advisories === null) {
        throw new Error("Saved advisory setting is unavailable");
      }
      settingsKnown = true;
      const response = await checkSecurity(force);
      if (request !== sequence.current) return;
      if (response.disabled) {
        setEnabledState(false);
        setAdvisories(new Map());
        setStale(false);
        setUnavailable(false);
        return;
      }
      setEnabledState(true);
      const map = new Map<string, PackageSecurityAdvisory[]>();
      for (const advisory of response.advisories) {
        const existing = map.get(advisory.package) ?? [];
        existing.push(advisory);
        map.set(advisory.package, existing);
      }
      setAdvisories(map);
      setStale(response.stale ?? false);
      setUnavailable(false);
    } catch (error) {
      if (request !== sequence.current) return;
      if (!settingsKnown) setEnabledState(null);
      setLoadError(error instanceof Error ? error.message : String(error));
      setAdvisories(new Map());
      setStale(false);
      setUnavailable(true);
    } finally {
      if (request === sequence.current) setLoading(false);
    }
  }, []);

  const clearToggleError = useCallback(() => setToggleError(null), []);

  const setEnabled = useCallback(
    async (next: boolean) => {
      if (writing.current || enabled === null) return;
      writing.current = true;
      ++sequence.current;
      const previous = enabled;
      setLoading(false);
      setToggleBusy(true);
      setToggleError(null);
      setEnabledState(next);
      try {
        const response = await setSecurityAdvisories(next);
        if (!response.success) {
          setEnabledState(previous);
          setToggleError(response.message);
          return;
        }
        writing.current = false;
        await load();
      } catch (err) {
        setEnabledState(previous);
        setToggleError(err instanceof Error ? err.message : String(err));
      } finally {
        writing.current = false;
        setToggleBusy(false);
      }
    },
    [load, enabled]
  );

  // Only advisories an update can clear; an unresolved record cannot be acted
  // on from here.
  const actionable = useMemo(() => {
    const map = new Map<string, PackageSecurityAdvisory[]>();
    for (const [pkg, list] of advisories) {
      const { actionable: fixable } = partitionAdvisories(list);
      if (fixable.length > 0) {
        map.set(pkg, fixable);
      }
    }
    return map;
  }, [advisories]);

  return { advisories, actionable, loading, stale, unavailable, loadError, enabled, toggleBusy, toggleError, clearToggleError, load, setEnabled };
}
