import { useState, useRef, useCallback, useEffect } from "react";
import { LOG_FLUSH_MS } from "../constants";
import { appendCapped } from "../utils";

export function useStreamingLog(): {
  log: string;
  appendLog: (data: string) => void;
  flushLog: () => void;
  resetLog: () => void;
} {
  const [log, setLog] = useState("");
  const buffer = useRef("");
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const flushLog = useCallback(() => {
    if (timer.current !== null) clearTimeout(timer.current);
    timer.current = null;
    const pending = buffer.current;
    buffer.current = "";
    if (pending) setLog((prev) => appendCapped(prev, pending));
  }, []);

  const appendLog = useCallback((data: string) => {
    buffer.current = appendCapped(buffer.current, data);
    if (timer.current === null) timer.current = setTimeout(flushLog, LOG_FLUSH_MS);
  }, [flushLog]);

  const resetLog = useCallback(() => {
    if (timer.current !== null) clearTimeout(timer.current);
    timer.current = null;
    buffer.current = "";
    setLog("");
  }, []);

  useEffect(() => () => {
    if (timer.current !== null) clearTimeout(timer.current);
  }, []);

  return { log, appendLog, flushLog, resetLog };
}
