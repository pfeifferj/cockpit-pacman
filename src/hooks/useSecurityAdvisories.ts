import { useState, useMemo, useCallback } from "react";
import { PackageSecurityAdvisory, checkSecurity, setSecurityAdvisories } from "../api";
import { partitionAdvisories } from "../security";

export function useSecurityAdvisories(): {
  advisories: Map<string, PackageSecurityAdvisory[]>;
  actionable: Map<string, PackageSecurityAdvisory[]>;
  loading: boolean;
  stale: boolean;
  unavailable: boolean;
  enabled: boolean;
  toggleBusy: boolean;
  load: (force?: boolean) => Promise<void>;
  setEnabled: (enabled: boolean) => Promise<void>;
} {
  const [advisories, setAdvisories] = useState<Map<string, PackageSecurityAdvisory[]>>(new Map());
  const [loading, setLoading] = useState(true);
  const [stale, setStale] = useState(false);
  const [enabled, setEnabledState] = useState(true);
  const [toggleBusy, setToggleBusy] = useState(false);
  const [unavailable, setUnavailable] = useState(false);

  const load = useCallback(async (force = false) => {
    setLoading(true);
    try {
      const response = await checkSecurity(force);
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
    } catch {
      setAdvisories(new Map());
      setStale(false);
      setUnavailable(true);
    } finally {
      setLoading(false);
    }
  }, []);

  const setEnabled = useCallback(
    async (next: boolean) => {
      setToggleBusy(true);
      setEnabledState(next);
      try {
        await setSecurityAdvisories(next);
        await load();
      } catch {
        setEnabledState(!next);
      } finally {
        setToggleBusy(false);
      }
    },
    [load]
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

  return { advisories, actionable, loading, stale, unavailable, enabled, toggleBusy, load, setEnabled };
}
