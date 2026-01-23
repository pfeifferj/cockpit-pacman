import { useEffect, useRef, MutableRefObject } from "react";

/**
 * Hook that auto-scrolls a container element to the bottom when content changes.
 * Useful for log containers that need to show the latest output.
 *
 * @param content - The content to watch for changes (typically a log string)
 * @returns A ref to attach to the scrollable container element
 */
export function useAutoScrollLog<T extends Element = HTMLDivElement>(
  content: string
): MutableRefObject<T | null> {
  const ref = useRef<T | null>(null);

  useEffect(() => {
    if (ref.current) {
      ref.current.scrollTop = ref.current.scrollHeight;
    }
  }, [content]);

  return ref;
}
