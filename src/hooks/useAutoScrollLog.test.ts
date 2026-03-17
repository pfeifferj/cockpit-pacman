import { describe, it, expect } from "vitest";
import { renderHook } from "@testing-library/react";
import { useAutoScrollLog } from "./useAutoScrollLog";

describe("useAutoScrollLog", () => {
  it("returns a ref object", () => {
    const { result } = renderHook(() => useAutoScrollLog(""));
    expect(result.current).toHaveProperty("current");
    expect(result.current.current).toBeNull();
  });

  it("scrolls to bottom when content changes", () => {
    const mockElement = {
      scrollTop: 0,
      scrollHeight: 500,
    };

    const { result, rerender } = renderHook(
      ({ content }) => useAutoScrollLog(content),
      { initialProps: { content: "line 1" } }
    );

    // Attach mock element to ref
    (result.current as { current: unknown }).current = mockElement;

    rerender({ content: "line 1\nline 2" });

    expect(mockElement.scrollTop).toBe(500);
  });
});
