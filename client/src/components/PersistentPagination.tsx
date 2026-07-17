import { Button } from "@/components/ui/button";
import { ChevronLeft, ChevronRight } from "lucide-react";
import { useCallback, useEffect, useMemo, useState } from "react";

type PersistentPaginationOptions = {
  storageKey: string;
  pageSize?: number;
  isReady?: boolean;
};

export type PersistentPaginationState<T> = {
  currentPage: number;
  totalPages: number;
  totalItems: number;
  pageSize: number;
  startItem: number;
  endItem: number;
  items: T[];
  setPage: (page: number) => void;
  nextPage: () => void;
  previousPage: () => void;
};

export type PersistentPageRequestState = {
  page: number;
  setPage: (page: number) => void;
};

function readStoredPage(storageKey: string) {
  if (typeof window === "undefined") return 1;
  try {
    const value = Number(window.localStorage.getItem(storageKey));
    return Number.isFinite(value) && value > 0 ? Math.floor(value) : 1;
  } catch {
    return 1;
  }
}

function writeStoredPage(storageKey: string, page: number) {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.setItem(storageKey, String(page));
  } catch {
    // Pagination still works without localStorage in restricted browsers.
  }
}

export function usePersistentPageRequest(storageKey: string): PersistentPageRequestState {
  const [page, setStoredPage] = useState(() => readStoredPage(storageKey));

  useEffect(() => {
    setStoredPage(readStoredPage(storageKey));
  }, [storageKey]);

  const setPage = useCallback((nextPage: number) => {
    const normalized = Math.max(1, Math.floor(Number(nextPage) || 1));
    setStoredPage(normalized);
    writeStoredPage(storageKey, normalized);
  }, [storageKey]);

  return { page, setPage };
}

export function useServerPagination<T>(
  items: T[],
  totalItems: number,
  request: PersistentPageRequestState,
  { pageSize = 12, isReady = true }: Omit<PersistentPaginationOptions, "storageKey"> = {},
): PersistentPaginationState<T> {
  const normalizedTotal = Math.max(0, Math.floor(Number(totalItems) || 0));
  const totalPages = isReady ? Math.max(1, Math.ceil(normalizedTotal / pageSize)) : Math.max(1, request.page);
  const currentPage = isReady ? Math.min(Math.max(request.page, 1), totalPages) : Math.max(request.page, 1);

  useEffect(() => {
    if (!isReady || request.page === currentPage) return;
    request.setPage(currentPage);
  }, [currentPage, isReady, request]);

  const setPage = (nextPage: number) => {
    const normalized = Math.floor(Number(nextPage) || 1);
    request.setPage(Math.min(Math.max(normalized, 1), totalPages));
  };
  const startItem = normalizedTotal === 0 ? 0 : (currentPage - 1) * pageSize + 1;
  const endItem = normalizedTotal === 0 ? 0 : Math.min(normalizedTotal, currentPage * pageSize);

  return {
    currentPage,
    totalPages,
    totalItems: normalizedTotal,
    pageSize,
    startItem,
    endItem,
    items: isReady ? items : [],
    setPage,
    nextPage: () => setPage(currentPage + 1),
    previousPage: () => setPage(currentPage - 1),
  };
}

function getPageWindow(currentPage: number, totalPages: number) {
  if (totalPages <= 5) return Array.from({ length: totalPages }, (_, index) => index + 1);
  const pages = new Set([1, totalPages, currentPage]);
  if (currentPage > 2) pages.add(currentPage - 1);
  if (currentPage < totalPages - 1) pages.add(currentPage + 1);
  return Array.from(pages).sort((a, b) => a - b);
}

export function usePersistentPagination<T>(
  items: T[],
  { storageKey, pageSize = 12, isReady = true }: PersistentPaginationOptions,
): PersistentPaginationState<T> {
  const [page, setStoredPage] = useState(() => readStoredPage(storageKey));
  const totalItems = items.length;
  const totalPages = isReady ? Math.max(1, Math.ceil(totalItems / pageSize)) : Math.max(1, page);
  const currentPage = isReady ? Math.min(Math.max(page, 1), totalPages) : Math.max(page, 1);

  useEffect(() => {
    setStoredPage(readStoredPage(storageKey));
  }, [storageKey]);

  useEffect(() => {
    if (!isReady) return;
    if (page === currentPage) return;
    setStoredPage(currentPage);
    writeStoredPage(storageKey, currentPage);
  }, [currentPage, isReady, page, storageKey]);

  const setPage = (nextPage: number) => {
    const raw = Number.isFinite(nextPage) ? Math.floor(nextPage) : 1;
    const maxPage = isReady ? totalPages : Math.max(1, raw);
    const clamped = Math.min(Math.max(raw, 1), maxPage);
    setStoredPage(clamped);
    writeStoredPage(storageKey, clamped);
  };

  const pagedItems = useMemo(() => {
    if (!isReady) return [];
    const start = (currentPage - 1) * pageSize;
    return items.slice(start, start + pageSize);
  }, [currentPage, isReady, items, pageSize]);

  const startItem = totalItems === 0 ? 0 : (currentPage - 1) * pageSize + 1;
  const endItem = totalItems === 0 ? 0 : Math.min(totalItems, currentPage * pageSize);

  return {
    currentPage,
    totalPages,
    totalItems,
    pageSize,
    startItem,
    endItem,
    items: pagedItems,
    setPage,
    nextPage: () => setPage(currentPage + 1),
    previousPage: () => setPage(currentPage - 1),
  };
}

export function PersistentPagination<T>({
  pagination,
  itemName = "项",
}: {
  pagination: PersistentPaginationState<T>;
  itemName?: string;
}) {
  if (pagination.totalItems <= pagination.pageSize) return null;
  const pages = getPageWindow(pagination.currentPage, pagination.totalPages);

  return (
    <div className="flex flex-col gap-3 rounded-lg border border-border/40 bg-card/60 px-3 py-3 text-sm sm:flex-row sm:items-center sm:justify-between">
      <div className="text-xs text-muted-foreground">
        第 {pagination.currentPage} / {pagination.totalPages} 页，显示 {pagination.startItem}-{pagination.endItem}，共 {pagination.totalItems} {itemName}
      </div>
      <div className="flex items-center justify-between gap-1 sm:justify-end">
        <Button
          variant="outline"
          size="sm"
          className="h-8 gap-1"
          disabled={pagination.currentPage <= 1}
          onClick={pagination.previousPage}
        >
          <ChevronLeft className="h-4 w-4" />
          上一页
        </Button>
        <div className="hidden items-center gap-1 sm:flex">
          {pages.map((page, index) => {
            const previous = pages[index - 1];
            const hasGap = previous && page - previous > 1;
            return (
              <div key={page} className="flex items-center gap-1">
                {hasGap && <span className="px-1 text-xs text-muted-foreground">...</span>}
                <Button
                  variant={page === pagination.currentPage ? "secondary" : "ghost"}
                  size="sm"
                  className="h-8 min-w-8 px-2"
                  onClick={() => pagination.setPage(page)}
                >
                  {page}
                </Button>
              </div>
            );
          })}
        </div>
        <Button
          variant="outline"
          size="sm"
          className="h-8 gap-1"
          disabled={pagination.currentPage >= pagination.totalPages}
          onClick={pagination.nextPage}
        >
          下一页
          <ChevronRight className="h-4 w-4" />
        </Button>
      </div>
    </div>
  );
}
