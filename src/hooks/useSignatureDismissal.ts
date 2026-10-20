import { useState, useEffect, useCallback, useRef, useMemo } from "react";
import { queueDismissal } from "./dismissalQueue";

export interface DismissalApi {
  get: () => Promise<{ signature: string | null }>;
  mark: (signature: string) => Promise<void>;
  restore: (prev: string | null, expected: string) => Promise<void>;
}

// mark-dismissed rejects control characters and signatures over 4096 bytes.
function storable(signature: string): string {
  const bytes = new TextEncoder().encode(signature);
  if (!/\p{Cc}/u.test(signature) && bytes.length <= 4096) return signature;
  let hash = 0xcbf29ce484222325n;
  for (const byte of bytes) hash = BigInt.asUintN(64, (hash ^ BigInt(byte)) * 0x100000001b3n);
  return `digest:${hash.toString(16)}`;
}

/** Tracks dismissal by signature; failed writes preserve newer intent. */
export function useSignatureDismissal(
  api: DismissalApi,
  rawSignature: string,
  onError?: (err: unknown) => void,
): {
  undismissed: boolean;
  dismissed: boolean;
  dismiss: () => () => void;
  undo: () => void;
  restore: () => void;
} {
  const signature = useMemo(() => storable(rawSignature), [rawSignature]);
  const [stored, setStoredState] = useState<string | null | undefined>(undefined);
  const confirmed = useRef<string | null | undefined>(undefined);
  const pending = useRef<{ id: number; value: () => string | null } | null>(null);
  const latestId = useRef(0);
  const mounted = useRef(false);
  const lastUndo = useRef<() => void>(() => {});
  const { get, mark, restore: restoreApi } = api;

  const currentValue = useCallback(() => pending.current ? pending.current.value() : confirmed.current, []);
  const publish = useCallback(() => {
    if (mounted.current) setStoredState(currentValue());
  }, [currentValue]);

  useEffect(() => {
    mounted.current = true;
    let cancelled = false;
    void queueDismissal(get, async () => {
      try {
        confirmed.current = (await get()).signature;
      } catch {
        confirmed.current ??= null;
      }
      if (!cancelled) publish();
    });
    return () => {
      cancelled = true;
      mounted.current = false;
    };
  }, [get, publish]);

  const write = useCallback((
    value: () => string | null,
    persist: (value: string | null) => Promise<void>,
    beforeWrite?: (value: string | null) => void,
  ) => {
    if (!mounted.current) return 0;
    const id = ++latestId.current;
    pending.current = { id, value };
    publish();
    void queueDismissal(get, async () => {
      beforeWrite?.(confirmed.current ?? null);
      const next = value();
      publish();
      try {
        await persist(next);
        confirmed.current = next;
      } catch (err) {
        if (mounted.current) onError?.(err);
      } finally {
        if (pending.current?.id === id) pending.current = null;
        publish();
      }
    });
    return id;
  }, [get, publish, onError]);

  const dismiss = useCallback(() => {
    const token = { id: 0, previous: currentValue() ?? null };
    token.id = write(() => signature, () => mark(signature), (previous) => { token.previous = previous; });
    const undo = () => {
      if (!mounted.current || latestId.current !== token.id || currentValue() !== signature) return;
      write(() => token.previous, (previous) => restoreApi(previous, signature));
    };
    lastUndo.current = undo;
    return undo;
  }, [write, mark, restoreApi, signature, currentValue]);

  const undo = useCallback(() => {
    lastUndo.current();
  }, []);

  const restore = useCallback(() => {
    const expected = currentValue();
    if (typeof expected === "string") write(() => null, () => restoreApi(null, expected));
  }, [write, restoreApi, currentValue]);

  const loaded = signature !== "" && stored !== undefined;
  return {
    undismissed: loaded && stored !== signature,
    dismissed: loaded && stored === signature,
    dismiss,
    undo,
    restore,
  };
}
