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
  /** The shown package was gone when refreshDetails re-read it. */
  detailsRemoved: boolean;
  fetchDetails: (name: string, options?: FetchDetailsOptions) => Promise<void>;
  /** Re-reads the last requested package, keeping the shown details until the reply. */
  refreshDetails: () => Promise<void>;
  clearDetails: () => void;
}

const isMissing = (err: unknown) => err instanceof BackendError && err.code === "not_found";

export function usePackageDetails(
  onError?: (error: string, code?: ErrorCode, details?: string) => void,
): UsePackageDetailsReturn {
  const [selectedPackage, setSelectedPackage] = useState<PackageDetailsData | null>(null);
  const [detailsLoading, setDetailsLoading] = useState(false);
  const [detailsError, setDetailsError] = useState<string | null>(null);
  const [detailsErrorCode, setDetailsErrorCode] = useState<ErrorCode>();
  const [detailsErrorContext, setDetailsErrorContext] = useState<string>();
  const [detailsRemoved, setDetailsRemoved] = useState(false);
  const requestIdRef = useRef(0);
  const lastRequestRef = useRef<{ name: string; options?: FetchDetailsOptions } | null>(null);
  const shownRef = useRef(false);

  const read = useCallback(async (
    name: string,
    options: FetchDetailsOptions | undefined,
    isStale: () => boolean,
  ): Promise<PackageDetailsData> => {
    const strategy = options?.strategy ?? "local";
    if (strategy === "sync") return getSyncPackageInfo(name, options?.repo);
    if (strategy === "local") return getPackageInfo(name);
    try {
      return await getPackageInfo(name);
    } catch (err) {
      if (isStale() || !isMissing(err)) throw err;
      return getSyncPackageInfo(name, options?.repo);
    }
  }, []);

  const fetchDetails = useCallback(async (
    name: string,
    options?: FetchDetailsOptions,
  ) => {
    const requestId = ++requestIdRef.current;
    lastRequestRef.current = { name, options };
    setDetailsLoading(true);
    setDetailsError(null);
    setDetailsErrorCode(undefined);
    setDetailsErrorContext(undefined);
    setDetailsRemoved(false);

    const isStale = () => requestId !== requestIdRef.current;

    try {
      const details = await read(name, options, isStale);
      if (isStale()) return;
      shownRef.current = true;
      setSelectedPackage(details);
    } catch (ex) {
      if (isStale()) return;
      const msg = ex instanceof Error ? ex.message : String(ex);
      shownRef.current = false;
      setSelectedPackage(null);
      setDetailsError(msg);
      const code = ex instanceof BackendError ? ex.code : undefined;
      const details = ex instanceof BackendError ? ex.details : undefined;
      setDetailsErrorCode(code);
      setDetailsErrorContext(details);
      onError?.(msg, code, details);
    } finally {
      if (!isStale()) {
        setDetailsLoading(false);
      }
    }
  }, [onError, read]);

  const refreshDetails = useCallback(async () => {
    const last = lastRequestRef.current;
    if (!last || !shownRef.current) return;
    const requestId = ++requestIdRef.current;
    const isStale = () => requestId !== requestIdRef.current;
    try {
      const details = await read(last.name, last.options, isStale);
      if (isStale()) return;
      setSelectedPackage(details);
      setDetailsError(null);
      setDetailsErrorCode(undefined);
      setDetailsErrorContext(undefined);
    } catch (ex) {
      if (isStale()) return;
      const code = ex instanceof BackendError ? ex.code : undefined;
      const context = ex instanceof BackendError ? ex.details : undefined;
      setDetailsErrorCode(code);
      setDetailsErrorContext(context);
      if (!isMissing(ex)) {
        const message = ex instanceof Error ? ex.message : String(ex);
        setDetailsError(message);
        onError?.(message, code, context);
        return;
      }
      shownRef.current = false;
      setSelectedPackage(null);
      setDetailsRemoved(true);
      setDetailsError(last.options?.strategy === "sync" && last.options.repo
        ? `${last.name} is no longer in ${last.options.repo}`
        : `${last.name} was removed outside this page`);
    } finally {
      if (!isStale()) setDetailsLoading(false);
    }
  }, [read, onError]);

  const clearDetails = useCallback(() => {
    requestIdRef.current++;
    lastRequestRef.current = null;
    shownRef.current = false;
    setDetailsLoading(false);
    setSelectedPackage(null);
    setDetailsError(null);
    setDetailsErrorCode(undefined);
    setDetailsErrorContext(undefined);
    setDetailsRemoved(false);
  }, []);

  return {
    selectedPackage,
    detailsLoading,
    detailsError,
    detailsRemoved,
    detailsErrorCode,
    detailsErrorContext,
    fetchDetails,
    refreshDetails,
    clearDetails,
  };
}
