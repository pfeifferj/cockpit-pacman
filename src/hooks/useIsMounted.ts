import { useRef, useEffect, useCallback } from "react";

/**
 * Hook to track component mount state for safe async operations.
 * Returns a function that returns true if the component is still mounted.
 *
 * @example
 * const isMounted = useIsMounted();
 *
 * const fetchData = async () => {
 *   const result = await api.getData();
 *   if (!isMounted()) return;
 *   setData(result);
 * };
 */
export function useIsMounted(): () => boolean {
  const isMountedRef = useRef(true);

  useEffect(() => {
    isMountedRef.current = true;
    return () => {
      isMountedRef.current = false;
    };
  }, []);

  return useCallback(() => isMountedRef.current, []);
}
