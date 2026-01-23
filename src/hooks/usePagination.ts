import React, { useState, useMemo, useCallback } from "react";

export interface UsePaginationOptions {
  defaultPerPage?: number;
  defaultPage?: number;
}

export interface UsePaginationResult {
  page: number;
  perPage: number;
  total: number;
  setPage: (page: number) => void;
  setPerPage: (perPage: number) => void;
  setTotal: (total: number) => void;
  offset: number;
  onSetPage: (_event: React.MouseEvent | React.KeyboardEvent | MouseEvent, newPage: number) => void;
  onPerPageSelect: (_event: React.MouseEvent | React.KeyboardEvent | MouseEvent, newPerPage: number) => void;
  resetPage: () => void;
}

export function usePagination(options: UsePaginationOptions = {}): UsePaginationResult {
  const { defaultPerPage = 50, defaultPage = 1 } = options;

  const [page, setPage] = useState(defaultPage);
  const [perPage, setPerPage] = useState(defaultPerPage);
  const [total, setTotal] = useState(0);

  const offset = useMemo(() => (page - 1) * perPage, [page, perPage]);

  const resetPage = useCallback(() => setPage(1), []);

  const onSetPage = useCallback(
    (_event: React.MouseEvent | React.KeyboardEvent | MouseEvent, newPage: number) => {
      setPage(newPage);
    },
    []
  );

  const onPerPageSelect = useCallback(
    (_event: React.MouseEvent | React.KeyboardEvent | MouseEvent, newPerPage: number) => {
      setPerPage(newPerPage);
      setPage(1);
    },
    []
  );

  return {
    page,
    perPage,
    total,
    setPage,
    setPerPage,
    setTotal,
    offset,
    onSetPage,
    onPerPageSelect,
    resetPage,
  };
}
