import { useState, useEffect, useCallback } from "react";

/** The stored signature is undefined while loading, null when nothing is dismissed. */
export function useSignatureDismissal(
  get: () => Promise<{ signature: string | null }>,
  mark: (signature: string) => Promise<void>,
  label: string,
  signature: string,
): { undismissed: boolean; dismiss: () => void } {
  const [dismissed, setDismissed] = useState<string | null | undefined>(undefined);

  useEffect(() => {
    get()
      .then((d) => setDismissed(d.signature))
      .catch(() => setDismissed(null));
  }, [get]);

  const dismiss = useCallback(() => {
    setDismissed(signature);
    mark(signature).catch((err) => {
      console.error(`Failed to persist ${label} dismissal:`, err);
    });
  }, [mark, label, signature]);

  return {
    undismissed: signature !== "" && dismissed !== undefined && dismissed !== signature,
    dismiss,
  };
}
