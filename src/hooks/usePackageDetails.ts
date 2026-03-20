import { useState, useRef, useCallback } from "react";
import {
  PackageDetails,
  SyncPackageDetails,
  getPackageInfo,
  getSyncPackageInfo,
} from "../api";

export type PackageDetailsData = PackageDetails | SyncPackageDetails;

export interface FetchDetailsOptions {
  repo?: string;
  strategy?: "local" | "sync" | "local-then-sync";
}

export interface UsePackageDetailsReturn {
  selectedPackage: PackageDetailsData | null;
  detailsLoading: boolean;
  detailsError: string | null;
  fetchDetails: (name: string, options?: FetchDetailsOptions) => Promise<void>;
  clearDetails: () => void;
}

export function usePackageDetails(
  onError?: (error: string) => void,
): UsePackageDetailsReturn {
  const [selectedPackage, setSelectedPackage] = useState<PackageDetailsData | null>(null);
  const [detailsLoading, setDetailsLoading] = useState(false);
  const [detailsError, setDetailsError] = useState<string | null>(null);
  const requestIdRef = useRef(0);

  const fetchDetails = useCallback(async (
    name: string,
    options?: FetchDetailsOptions,
  ) => {
    const strategy = options?.strategy ?? "local";
    const requestId = ++requestIdRef.current;
    setDetailsLoading(true);
    setDetailsError(null);
    setSelectedPackage(null);

    const isStale = () => requestId !== requestIdRef.current;

    try {
      if (strategy === "sync") {
        const details = await getSyncPackageInfo(name, options?.repo);
        if (isStale()) return;
        setSelectedPackage(details);
      } else if (strategy === "local-then-sync") {
        try {
          const details = await getPackageInfo(name);
          if (isStale()) return;
          setSelectedPackage(details);
        } catch {
          if (isStale()) return;
          try {
            const syncDetails = await getSyncPackageInfo(name);
            if (isStale()) return;
            setSelectedPackage(syncDetails);
          } catch {
            if (isStale()) return;
            const msg = `Package '${name}' not found locally or in sync databases`;
            setDetailsError(msg);
            onError?.(msg);
          }
        }
      } else {
        const details = await getPackageInfo(name);
        if (isStale()) return;
        setSelectedPackage(details);
      }
    } catch (ex) {
      if (isStale()) return;
      const msg = ex instanceof Error ? ex.message : String(ex);
      setDetailsError(msg);
      onError?.(msg);
    } finally {
      if (!isStale()) {
        setDetailsLoading(false);
      }
    }
  }, [onError]);

  const clearDetails = useCallback(() => {
    setSelectedPackage(null);
    setDetailsError(null);
  }, []);

  return {
    selectedPackage,
    detailsLoading,
    detailsError,
    fetchDetails,
    clearDetails,
  };
}
