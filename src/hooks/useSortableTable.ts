import { useState, useCallback } from "react";
import { ThProps } from "@patternfly/react-table";

export type SortDirection = "asc" | "desc";

export interface UseSortableTableOptions {
  sortableColumns: number[];
  defaultDirection?: SortDirection;
  onSort?: (index: number, direction: SortDirection) => void;
}

export interface UseSortableTableReturn {
  activeSortIndex: number | null;
  activeSortDirection: SortDirection;
  setActiveSortIndex: (index: number | null) => void;
  setActiveSortDirection: (direction: SortDirection) => void;
  getSortParams: (columnIndex: number) => ThProps["sort"] | undefined;
  resetSort: () => void;
}

export function useSortableTable(options: UseSortableTableOptions): UseSortableTableReturn {
  const { sortableColumns, defaultDirection = "asc", onSort } = options;

  const [activeSortIndex, setActiveSortIndex] = useState<number | null>(null);
  const [activeSortDirection, setActiveSortDirection] = useState<SortDirection>(defaultDirection);

  const getSortParams = useCallback((columnIndex: number): ThProps["sort"] | undefined => {
    if (!sortableColumns.includes(columnIndex)) return undefined;
    return {
      sortBy: {
        index: activeSortIndex ?? undefined,
        direction: activeSortDirection,
        defaultDirection,
      },
      onSort: (_event, index, direction) => {
        setActiveSortIndex(index);
        setActiveSortDirection(direction);
        onSort?.(index, direction);
      },
      columnIndex,
    };
  }, [sortableColumns, activeSortIndex, activeSortDirection, defaultDirection, onSort]);

  const resetSort = useCallback(() => {
    setActiveSortIndex(null);
    setActiveSortDirection(defaultDirection);
  }, [defaultDirection]);

  return {
    activeSortIndex,
    activeSortDirection,
    setActiveSortIndex,
    setActiveSortDirection,
    getSortParams,
    resetSort,
  };
}
