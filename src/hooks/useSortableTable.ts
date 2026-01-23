import { useState, useCallback, useMemo } from "react";
import { ThProps } from "@patternfly/react-table";

export type SortDirection = "asc" | "desc";

/** Column mapping from string keys to numeric indices */
export type ColumnMap<K extends string = string> = Record<K, number>;

/** Options with string-based column keys (recommended) */
export interface UseSortableTableOptionsWithColumns<K extends string = string> {
  /** Map of column keys to their indices, e.g. { name: 1, repo: 2 } */
  columns: ColumnMap<K>;
  sortableColumns?: never;
  defaultDirection?: SortDirection;
  onSort?: (key: K | null, direction: SortDirection) => void;
}

/** Legacy options with numeric column indices */
export interface UseSortableTableOptionsLegacy {
  /** Array of sortable column indices (legacy - prefer `columns` map) */
  sortableColumns: number[];
  columns?: never;
  defaultDirection?: SortDirection;
  onSort?: (index: number, direction: SortDirection) => void;
}

export type UseSortableTableOptions<K extends string = string> =
  | UseSortableTableOptionsWithColumns<K>
  | UseSortableTableOptionsLegacy;

export interface UseSortableTableReturn<K extends string = string> {
  /** The currently active sort column key (only available when using `columns` option) */
  activeSortKey: K | null;
  /** The currently active sort column index */
  activeSortIndex: number | null;
  activeSortDirection: SortDirection;
  setActiveSortKey: (key: K | null) => void;
  setActiveSortIndex: (index: number | null) => void;
  setActiveSortDirection: (direction: SortDirection) => void;
  /** Get sort params for a column (accepts key when using `columns`, index when using `sortableColumns`) */
  getSortParams: (columnKeyOrIndex: K | number) => ThProps["sort"] | undefined;
  resetSort: () => void;
}

export function useSortableTable<K extends string = string>(
  options: UseSortableTableOptions<K>
): UseSortableTableReturn<K> {
  const { defaultDirection = "asc" } = options;

  const [activeSortIndex, setActiveSortIndexInternal] = useState<number | null>(null);
  const [activeSortDirection, setActiveSortDirection] = useState<SortDirection>(defaultDirection);

  // Determine if using new columns-based or legacy sortableColumns-based options
  const isColumnsMode = "columns" in options && options.columns !== undefined;
  const columns = isColumnsMode ? (options as UseSortableTableOptionsWithColumns<K>).columns : null;
  const sortableColumns = !isColumnsMode ? (options as UseSortableTableOptionsLegacy).sortableColumns : null;

  // Build reverse map from index to key (only in columns mode)
  const indexToKey = useMemo(() => {
    if (!columns) return new Map<number, K>();
    const map = new Map<number, K>();
    for (const [key, index] of Object.entries(columns) as [K, number][]) {
      map.set(index, key);
    }
    return map;
  }, [columns]);

  const sortableIndices = useMemo(() => {
    if (columns) return Object.values(columns);
    return sortableColumns ?? [];
  }, [columns, sortableColumns]);

  const activeSortKey = useMemo(() => {
    if (!columns || activeSortIndex === null) return null;
    return indexToKey.get(activeSortIndex) ?? null;
  }, [columns, activeSortIndex, indexToKey]);

  const setActiveSortIndex = useCallback((index: number | null) => {
    setActiveSortIndexInternal(index);
  }, []);

  const setActiveSortKey = useCallback((key: K | null) => {
    if (!columns) return;
    if (key === null) {
      setActiveSortIndexInternal(null);
    } else {
      setActiveSortIndexInternal(columns[key] ?? null);
    }
  }, [columns]);

  const getSortParams = useCallback((columnKeyOrIndex: K | number): ThProps["sort"] | undefined => {
    const columnIndex = typeof columnKeyOrIndex === "number"
      ? columnKeyOrIndex
      : columns?.[columnKeyOrIndex];

    if (columnIndex === undefined || !sortableIndices.includes(columnIndex)) return undefined;

    return {
      sortBy: {
        index: activeSortIndex ?? undefined,
        direction: activeSortDirection,
        defaultDirection,
      },
      onSort: (_event, index, direction) => {
        setActiveSortIndexInternal(index);
        setActiveSortDirection(direction);
        if (isColumnsMode && "onSort" in options && options.onSort) {
          const key = indexToKey.get(index) ?? null;
          (options.onSort as (key: K | null, direction: SortDirection) => void)(key, direction);
        } else if (!isColumnsMode && "onSort" in options && options.onSort) {
          (options.onSort as (index: number, direction: SortDirection) => void)(index, direction);
        }
      },
      columnIndex,
    };
  }, [columns, sortableIndices, activeSortIndex, activeSortDirection, defaultDirection, indexToKey, isColumnsMode, options]);

  const resetSort = useCallback(() => {
    setActiveSortIndexInternal(null);
    setActiveSortDirection(defaultDirection);
  }, [defaultDirection]);

  return {
    activeSortKey,
    activeSortIndex,
    activeSortDirection,
    setActiveSortKey,
    setActiveSortIndex,
    setActiveSortDirection,
    getSortParams,
    resetSort,
  };
}
