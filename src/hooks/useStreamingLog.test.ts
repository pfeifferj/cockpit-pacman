import { describe, it, expect, vi, afterEach } from "vitest";
import { renderHook, act, cleanup } from "@testing-library/react";
import { useStreamingLog } from "./useStreamingLog";
import { LOG_FLUSH_MS } from "../constants";

describe("useStreamingLog", () => {
  afterEach(() => { cleanup(); vi.useRealTimers(); });

  it("batches events and flushes the final lines immediately", () => {
    vi.useFakeTimers();
    const { result } = renderHook(() => useStreamingLog());
    act(() => {
      for (let index = 0; index < 100; index++) result.current.appendLog(`${index}\n`);
    });
    expect(result.current.log).toBe("");
    act(() => vi.advanceTimersByTime(LOG_FLUSH_MS));
    expect(result.current.log).toContain("99\n");
    act(() => {
      result.current.appendLog("Finished\n");
      result.current.flushLog();
    });
    expect(result.current.log).toMatch(/Finished\n$/);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("discards buffered output when starting another operation", () => {
    vi.useFakeTimers();
    const { result } = renderHook(() => useStreamingLog());
    act(() => {
      result.current.appendLog("old output\n");
      result.current.resetLog();
      result.current.appendLog("new output\n");
      result.current.flushLog();
    });
    expect(result.current.log).toBe("new output\n");
  });
});
