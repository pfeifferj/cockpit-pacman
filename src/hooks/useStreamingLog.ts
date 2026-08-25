import { useState, useRef, useCallback, useEffect } from "react";
import { LOG_FLUSH_MS } from "../constants";
import { appendCapped } from "../utils";

export function useStreamingLog(): {
  log: string;
  appendLog: (data: string) => void;
  resetLog: () => void;
} {
  const [log, setLog] = useState("");
  const buffer = useRef("");
  const flush = useRef<ReturnType<typeof setTimeout> | null>(null);

  // One upgrade emits tens of thousands of stream events, and a setState each
  // re-renders the view far faster than anything can be read. Coalescing into
  // one append per interval keeps the string concatenation off that path too.
  const appendLog = useCallback((data: string) => {
    buffer.current += data;
    if (flush.current !== null) return;
    flush.current = setTimeout(() => {
      flush.current = null;
      const pending = buffer.current;
      buffer.current = "";
      if (pending) setLog((prev) => appendCapped(prev, pending));
    }, LOG_FLUSH_MS);
  }, []);

  const resetLog = useCallback(() => {
    if (flush.current !== null) {
      clearTimeout(flush.current);
      flush.current = null;
    }
    buffer.current = "";
    setLog("");
  }, []);

  useEffect(() => () => {
    if (flush.current !== null) clearTimeout(flush.current);
  }, []);

  return { log, appendLog, resetLog };
}
