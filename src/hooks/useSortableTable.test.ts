import React from "react";
import { describe, it, expect, vi } from "vitest";
import { renderHook, act } from "@testing-library/react";
import { useSortableTable } from "./useSortableTable";

// PatternFly's onSort expects SortByDirection enum, but the values are just "asc"/"desc" strings
const asc = "asc" as never;
const desc = "desc" as never;

describe("useSortableTable", () => {
  describe("columns mode", () => {
    const columns = { name: 0, version: 1, size: 2 } as const;

    it("starts with no active sort", () => {
      const { result } = renderHook(() =>
        useSortableTable({ columns })
      );
      expect(result.current.activeSortIndex).toBeNull();
      expect(result.current.activeSortKey).toBeNull();
      expect(result.current.activeSortDirection).toBe("asc");
    });

    it("setActiveSortKey updates index and key", () => {
      const { result } = renderHook(() =>
        useSortableTable({ columns })
      );

      act(() => { result.current.setActiveSortKey("version"); });
      expect(result.current.activeSortKey).toBe("version");
      expect(result.current.activeSortIndex).toBe(1);
    });

    it("setActiveSortKey(null) clears sort", () => {
      const { result } = renderHook(() =>
        useSortableTable({ columns })
      );

      act(() => { result.current.setActiveSortKey("name"); });
      act(() => { result.current.setActiveSortKey(null); });
      expect(result.current.activeSortKey).toBeNull();
      expect(result.current.activeSortIndex).toBeNull();
    });

    it("getSortParams returns sort config for valid column", () => {
      const { result } = renderHook(() =>
        useSortableTable({ columns })
      );

      const params = result.current.getSortParams("name");
      expect(params).toBeDefined();
      expect(params!.columnIndex).toBe(0);
    });

    it("getSortParams returns undefined for unknown column", () => {
      const { result } = renderHook(() =>
        useSortableTable({ columns })
      );

      const params = result.current.getSortParams("nonexistent" as never);
      expect(params).toBeUndefined();
    });

    it("onSort callback fires with key in columns mode", () => {
      const onSort = vi.fn();
      const { result } = renderHook(() =>
        useSortableTable({ columns, onSort })
      );

      const params = result.current.getSortParams("name");
      act(() => {
        params!.onSort!({} as React.MouseEvent, 0, desc, {} as never);
      });

      expect(onSort).toHaveBeenCalledWith("name", "desc");
      expect(result.current.activeSortIndex).toBe(0);
      expect(result.current.activeSortDirection).toBe("desc");
    });

    it("resetSort clears to initial state", () => {
      const { result } = renderHook(() =>
        useSortableTable({ columns, defaultDirection: "desc" })
      );

      act(() => { result.current.setActiveSortKey("size"); });
      act(() => { result.current.setActiveSortDirection("asc"); });
      act(() => { result.current.resetSort(); });

      expect(result.current.activeSortIndex).toBeNull();
      expect(result.current.activeSortDirection).toBe("desc");
    });
  });

  describe("legacy sortableColumns mode", () => {
    it("getSortParams works with numeric indices", () => {
      const { result } = renderHook(() =>
        useSortableTable({ sortableColumns: [0, 1, 3] })
      );

      expect(result.current.getSortParams(0)).toBeDefined();
      expect(result.current.getSortParams(2)).toBeUndefined();
      expect(result.current.getSortParams(3)).toBeDefined();
    });

    it("onSort callback fires with index in legacy mode", () => {
      const onSort = vi.fn();
      const { result } = renderHook(() =>
        useSortableTable({ sortableColumns: [0, 1], onSort })
      );

      const params = result.current.getSortParams(1);
      act(() => {
        params!.onSort!({} as React.MouseEvent, 1, asc, {} as never);
      });

      expect(onSort).toHaveBeenCalledWith(1, "asc");
    });

    it("activeSortKey is always null in legacy mode", () => {
      const { result } = renderHook(() =>
        useSortableTable({ sortableColumns: [0, 1] })
      );

      act(() => { result.current.setActiveSortIndex(0); });
      expect(result.current.activeSortKey).toBeNull();
    });
  });
});
