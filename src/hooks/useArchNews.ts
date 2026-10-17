import { useState, useEffect, useMemo, useCallback } from "react";
import { NEWS_LOOKBACK_DAYS } from "../constants";
import { NewsItem, fetchNews, getNewsReadState, markNewsRead } from "../api";

export function useArchNews(): {
  items: NewsItem[];
  error: boolean;
  stale: boolean;
  dismiss: (link: string) => void;
  clearError: () => void;
  refresh: () => void;
} {
  const [refreshCount, setRefreshCount] = useState(0);
  const [items, setItems] = useState<NewsItem[]>([]);
  const [error, setError] = useState(false);
  const [stale, setStale] = useState(false);
  const [dismissed, setDismissed] = useState<Set<string>>(new Set<string>());

  useEffect(() => {
    let cancelled = false;
    getNewsReadState()
      .then((data) => {
        if (!cancelled) {
          setDismissed(new Set(data.dismissed));
        }
      })
      .catch(() => { /* ignore: persistence unavailable */ });
    return () => { cancelled = true; };
  }, []);

  useEffect(() => {
    let cancelled = false;
    fetchNews(NEWS_LOOKBACK_DAYS, refreshCount > 0)
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
  }, [refreshCount]);

  const visible = useMemo(
    () => items.filter((item) => !dismissed.has(item.link)),
    [items, dismissed]
  );

  const dismiss = useCallback((link: string) => {
    setDismissed((prev) => {
      const next = new Set(prev);
      next.add(link);
      return next;
    });
    void markNewsRead(link).catch(() => { /* ignore: persistence unavailable */ });
  }, []);

  const clearError = useCallback(() => setError(false), []);

  const refresh = useCallback(() => setRefreshCount(count => count + 1), []);

  return { items: visible, error, stale, dismiss, clearError, refresh };
}
