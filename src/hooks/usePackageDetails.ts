import { useState, useRef, useCallback } from "react";
import {
  PackageDetails,
  SyncPackageDetails,
  getPackageInfo,
  getSyncPackageInfo,
  BackendError,
  type ErrorCode,
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
  detailsErrorCode?: ErrorCode;
  detailsErrorContext?: string;
  fetchDetails: (name: string, options?: FetchDetailsOptions) => Promise<void>;
  clearDetails: () => void;
}

export function usePackageDetails(
  onError?: (error: string, code?: ErrorCode, details?: string) => void,
): UsePackageDetailsReturn {
  const [selectedPackage, setSelectedPackage] = useState<PackageDetailsData | null>(null);
  const [detailsLoading, setDetailsLoading] = useState(false);
  const [detailsError, setDetailsError] = useState<string | null>(null);
  const [detailsErrorCode, setDetailsErrorCode] = useState<ErrorCode | undefined>();
  const [detailsErrorContext, setDetailsErrorContext] = useState<string | undefined>();
  const requestIdRef = useRef(0);

  const fetchDetails = useCallback(async (
    name: string,
    options?: FetchDetailsOptions,
  ) => {
    const strategy = options?.strategy ?? "local";
    const requestId = ++requestIdRef.current;
    setDetailsLoading(true);
    setDetailsError(null);
    setDetailsErrorCode(undefined);
    setDetailsErrorContext(undefined);
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
        } catch (localError) {
          if (isStale()) return;
          try {
            const syncDetails = await getSyncPackageInfo(name, options?.repo);
            if (isStale()) return;
            setSelectedPackage(syncDetails);
          } catch (syncError) {
            if (isStale()) return;
            const msg = `Could not load package '${name}' from local or sync databases`;
            const context = (error: unknown) => error instanceof BackendError
              ? [error.message, error.details].filter(Boolean).join("\n")
              : error instanceof Error ? error.message : String(error);
            const details = `Local database: ${context(localError)}\nSync databases: ${context(syncError)}`;
            const code = syncError instanceof BackendError ? syncError.code : undefined;
            setDetailsError(msg);
            setDetailsErrorCode(code);
            setDetailsErrorContext(details);
            onError?.(msg, code, details);
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
      const code = ex instanceof BackendError ? ex.code : undefined;
      const details = ex instanceof BackendError ? ex.details : undefined;
      setDetailsError(msg);
      setDetailsErrorCode(code);
      setDetailsErrorContext(details);
      onError?.(msg, code, details);
    } finally {
      if (!isStale()) {
        setDetailsLoading(false);
      }
    }
  }, [onError]);

  const clearDetails = useCallback(() => {
    setSelectedPackage(null);
    setDetailsError(null);
    setDetailsErrorCode(undefined);
    setDetailsErrorContext(undefined);
  }, []);

  return {
    selectedPackage,
    detailsLoading,
    detailsError,
    detailsErrorCode,
    detailsErrorContext,
    fetchDetails,
    clearDetails,
  };
}
