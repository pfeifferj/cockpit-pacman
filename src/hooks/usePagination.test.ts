import React from "react";
import { describe, it, expect } from "vitest";
import { renderHook, act } from "@testing-library/react";
import { usePagination } from "./usePagination";

describe("usePagination", () => {
  it("uses default values", () => {
    const { result } = renderHook(() => usePagination());
    expect(result.current.page).toBe(1);
    expect(result.current.perPage).toBe(50);
    expect(result.current.total).toBe(0);
    expect(result.current.offset).toBe(0);
  });

  it("accepts custom defaults", () => {
    const { result } = renderHook(() =>
      usePagination({ defaultPerPage: 25, defaultPage: 3 })
    );
    expect(result.current.page).toBe(3);
    expect(result.current.perPage).toBe(25);
    expect(result.current.offset).toBe(50); // (3-1)*25
  });

  it("computes offset from page and perPage", () => {
    const { result } = renderHook(() => usePagination());

    act(() => { result.current.setPage(3); });
    expect(result.current.offset).toBe(100); // (3-1)*50

    act(() => { result.current.setPerPage(20); });
    // perPage change doesn't reset page here, but onPerPageSelect does
    expect(result.current.offset).toBe(40); // (3-1)*20
  });

  it("onSetPage updates the page", () => {
    const { result } = renderHook(() => usePagination());

    act(() => {
      result.current.onSetPage({} as React.MouseEvent, 5);
    });
    expect(result.current.page).toBe(5);
  });

  it("onPerPageSelect updates perPage and resets to page 1", () => {
    const { result } = renderHook(() => usePagination());

    act(() => { result.current.setPage(3); });
    expect(result.current.page).toBe(3);

    act(() => {
      result.current.onPerPageSelect({} as React.MouseEvent, 25);
    });
    expect(result.current.perPage).toBe(25);
    expect(result.current.page).toBe(1);
  });

  it("resetPage sets page back to 1", () => {
    const { result } = renderHook(() => usePagination());

    act(() => { result.current.setPage(10); });
    expect(result.current.page).toBe(10);

    act(() => { result.current.resetPage(); });
    expect(result.current.page).toBe(1);
  });

  it("setTotal updates total", () => {
    const { result } = renderHook(() => usePagination());

    act(() => { result.current.setTotal(500); });
    expect(result.current.total).toBe(500);
  });
});
