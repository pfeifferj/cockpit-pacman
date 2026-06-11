import { useState, useEffect, useCallback } from "react";

/**
 * Loads a persisted dismissal signature and returns it with a dismiss
 * function that updates state optimistically and persists in the background.
 * The signature is undefined while loading, null when nothing is dismissed.
 */
export function useDismissalSignature(
  get: () => Promise<{ signature: string | null }>,
  mark: (signature: string) => Promise<void>,
  label: string,
): [string | null | undefined, (signature: string) => void] {
  const [dismissed, setDismissed] = useState<string | null | undefined>(undefined);

  useEffect(() => {
    get()
      .then((d) => setDismissed(d.signature))
      .catch(() => setDismissed(null));
  }, [get]);

  const dismiss = useCallback((signature: string) => {
    setDismissed(signature);
    mark(signature).catch((err) => {
      console.error(`Failed to persist ${label} dismissal:`, err);
    });
  }, [mark, label]);

  return [dismissed, dismiss];
}
