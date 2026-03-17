import { describe, it, expect, vi, beforeEach } from "vitest";
import { renderHook, act } from "@testing-library/react";
import { useDebouncedValue } from "./useDebounce";

describe("useDebouncedValue", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  it("returns initial value immediately", () => {
    const { result } = renderHook(() => useDebouncedValue("hello", 300));
    expect(result.current).toBe("hello");
  });

  it("does not update before delay expires", () => {
    const { result, rerender } = renderHook(
      ({ value, delay }) => useDebouncedValue(value, delay),
      { initialProps: { value: "hello", delay: 300 } }
    );

    rerender({ value: "world", delay: 300 });
    act(() => { vi.advanceTimersByTime(200); });

    expect(result.current).toBe("hello");
  });

  it("updates after delay expires", () => {
    const { result, rerender } = renderHook(
      ({ value, delay }) => useDebouncedValue(value, delay),
      { initialProps: { value: "hello", delay: 300 } }
    );

    rerender({ value: "world", delay: 300 });
    act(() => { vi.advanceTimersByTime(300); });

    expect(result.current).toBe("world");
  });

  it("resets timer on rapid changes", () => {
    const { result, rerender } = renderHook(
      ({ value, delay }) => useDebouncedValue(value, delay),
      { initialProps: { value: "a", delay: 300 } }
    );

    rerender({ value: "b", delay: 300 });
    act(() => { vi.advanceTimersByTime(200); });

    rerender({ value: "c", delay: 300 });
    act(() => { vi.advanceTimersByTime(200); });

    // "b" should never have appeared
    expect(result.current).toBe("a");

    act(() => { vi.advanceTimersByTime(100); });
    expect(result.current).toBe("c");
  });

  it("works with non-string types", () => {
    const { result, rerender } = renderHook(
      ({ value, delay }) => useDebouncedValue(value, delay),
      { initialProps: { value: 42, delay: 100 } }
    );

    rerender({ value: 99, delay: 100 });
    act(() => { vi.advanceTimersByTime(100); });

    expect(result.current).toBe(99);
  });
});
