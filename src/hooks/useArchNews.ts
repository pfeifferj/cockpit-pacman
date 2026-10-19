import { useState, useEffect, useMemo, useCallback, useRef } from "react";
import { NEWS_LOOKBACK_DAYS } from "../constants";
import { NewsItem, fetchNews, getNewsReadState, markNewsRead, markNewsUnread } from "../api";
import { queueDismissal } from "./dismissalQueue";

export interface NewsDismissal {
  links: string[];
  undo: () => void;
}

interface NewsWrite {
  link: string;
  id: number;
  previous: boolean;
}

/** Loads news and persists reversible dismissals. Fetching waits for `enabled`. */
export function useArchNews(onError?: (err: unknown) => void, enabled = true): {
  items: NewsItem[];
  dismissedInWindow: NewsItem[];
  error: boolean;
  stale: boolean;
  dismiss: (link: string) => NewsDismissal;
  dismissAll: () => NewsDismissal;
  undo: (links?: string[]) => void;
  restore: (link: string) => void;
  clearError: () => void;
  reload: () => void;
} {
  const [items, setItems] = useState<NewsItem[]>([]);
  const [error, setError] = useState(false);
  const [stale, setStale] = useState(false);
  const [dismissed, setDismissed] = useState<Set<string>>(new Set<string>());
  const confirmed = useRef(new Set<string>());
  const pending = useRef(new Map<string, { id: number; value: () => boolean }>());
  const latestIds = useRef(new Map<string, number>());
  const sequence = useRef(0);
  const mounted = useRef(false);
  const lastBatchRef = useRef<NewsWrite[]>([]);
  const [generation, setGeneration] = useState(0);

  const isDismissed = useCallback((link: string) => {
    const intent = pending.current.get(link);
    return intent ? intent.value() : confirmed.current.has(link);
  }, []);

  const publish = useCallback(() => {
    if (!mounted.current) return;
    const next = new Set(confirmed.current);
    for (const [link, intent] of pending.current) {
      if (intent.value()) next.add(link);
      else next.delete(link);
    }
    setDismissed(next);
  }, []);

  useEffect(() => {
    mounted.current = true;
    return () => { mounted.current = false; };
  }, []);

  useEffect(() => {
    if (!enabled) return;
    let cancelled = false;
    void queueDismissal(getNewsReadState, async () => {
      try {
        confirmed.current = new Set((await getNewsReadState()).dismissed);
      } catch { /* keep the last known state when persistence is unavailable */ }
      if (!cancelled) publish();
    });
    fetchNews(NEWS_LOOKBACK_DAYS, generation > 0)
      .then((r) => {
        if (cancelled) return;
        setError(false);
        setStale(r.stale ?? false);
        setItems(r.items);
      })
      .catch(() => {
        if (cancelled) return;
        setError(true);
        setStale(false);
        setItems([]);
      });
    return () => { cancelled = true; };
  }, [enabled, generation, publish]);

  const visible = useMemo(
    () => items.filter((item) => !dismissed.has(item.link)),
    [items, dismissed]
  );
  const dismissedInWindow = useMemo(
    () => items.filter((item) => dismissed.has(item.link)),
    [items, dismissed]
  );

  const apply = useCallback((changes: { link: string; value: () => boolean }[]): NewsWrite[] => {
    if (!mounted.current || changes.length === 0) return [];
    const writes = changes.map(({ link, value }) => {
      const previous = isDismissed(link);
      const id = ++sequence.current;
      latestIds.current.set(link, id);
      pending.current.set(link, { id, value });
      return { link, id, previous };
    });
    publish();
    const tasks = writes.map((write, index) => queueDismissal(getNewsReadState, async () => {
      write.previous = confirmed.current.has(write.link);
      const hide = changes[index].value();
      publish();
      try {
        await (hide ? markNewsRead : markNewsUnread)(write.link);
        if (hide) confirmed.current.add(write.link);
        else confirmed.current.delete(write.link);
      } finally {
        if (pending.current.get(write.link)?.id === write.id) pending.current.delete(write.link);
        publish();
      }
    }));
    void Promise.allSettled(tasks).then((results) => {
      const first = results.find((r): r is PromiseRejectedResult => r.status === "rejected");
      if (first && mounted.current) onError?.(first.reason);
    });
    return writes;
  }, [publish, onError, isDismissed]);

  const undoBatch = useCallback((writes: NewsWrite[]) => {
    if (!mounted.current) return;
    apply(writes
      .filter((write) => latestIds.current.get(write.link) === write.id && isDismissed(write.link))
      .map((write) => ({ link: write.link, value: () => write.previous })));
  }, [apply, isDismissed]);

  const dismissLinks = useCallback((links: string[]): NewsDismissal => {
    const unique = [...new Set(links)];
    const writes = apply(unique.map((link) => ({ link, value: () => true })));
    lastBatchRef.current = writes;
    return { links: unique, undo: () => undoBatch(writes) };
  }, [apply, undoBatch]);

  const dismiss = useCallback((link: string) => dismissLinks([link]), [dismissLinks]);

  const dismissAll = useCallback(() => {
    return dismissLinks(items.filter((item) => !isDismissed(item.link)).map((item) => item.link));
  }, [dismissLinks, isDismissed, items]);

  const undo = useCallback((links?: string[]) => {
    undoBatch(links ? lastBatchRef.current.filter((write) => links.includes(write.link)) : lastBatchRef.current);
  }, [undoBatch]);

  const restore = useCallback((link: string) => {
    apply([{ link, value: () => false }]);
  }, [apply]);

  const clearError = useCallback(() => setError(false), []);

  const reload = useCallback(() => {
    setError(false);
    setGeneration((g) => g + 1);
  }, []);

  return { items: visible, dismissedInWindow, error, stale, dismiss, dismissAll, undo, restore, clearError, reload };
}
