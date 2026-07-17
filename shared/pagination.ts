export type PageRequest = {
  page?: number;
  pageSize?: number;
};

export type PageResult<T> = {
  items: T[];
  page: number;
  pageSize: number;
  totalItems: number;
  totalPages: number;
};

export type PageWindow = {
  page: number;
  pageSize: number;
  offset: number;
};

export function normalizePageRequest(input: PageRequest | null | undefined, defaultPageSize = 12) {
  const page = Math.max(1, Math.floor(Number(input?.page) || 1));
  const pageSize = Math.min(100, Math.max(1, Math.floor(Number(input?.pageSize) || defaultPageSize)));
  return { page, pageSize };
}

export function pageWindow(input: PageRequest | null | undefined, defaultPageSize = 12): PageWindow {
  const request = normalizePageRequest(input, defaultPageSize);
  return {
    ...request,
    offset: (request.page - 1) * request.pageSize,
  };
}

export function pageWindowForTotal(
  input: PageRequest | null | undefined,
  totalItems: number,
  defaultPageSize = 12,
): PageWindow {
  const request = normalizePageRequest(input, defaultPageSize);
  const safeTotalItems = Math.max(0, Math.floor(Number(totalItems) || 0));
  const totalPages = Math.max(1, Math.ceil(safeTotalItems / request.pageSize));
  const page = Math.min(request.page, totalPages);
  return { page, pageSize: request.pageSize, offset: (page - 1) * request.pageSize };
}

export function pageResult<T>(
  items: T[],
  totalItems: number,
  input: PageRequest | null | undefined,
  defaultPageSize = 12,
): PageResult<T> {
  const request = normalizePageRequest(input, defaultPageSize);
  const safeTotalItems = Math.max(0, Math.floor(Number(totalItems) || 0));
  const totalPages = Math.max(1, Math.ceil(safeTotalItems / request.pageSize));
  return {
    items,
    page: Math.min(request.page, totalPages),
    pageSize: request.pageSize,
    totalItems: safeTotalItems,
    totalPages,
  };
}

export function paginateItems<T>(items: T[], input: PageRequest | null | undefined, defaultPageSize = 12): PageResult<T> {
  const request = normalizePageRequest(input, defaultPageSize);
  const totalItems = items.length;
  const totalPages = Math.max(1, Math.ceil(totalItems / request.pageSize));
  const page = Math.min(request.page, totalPages);
  const start = (page - 1) * request.pageSize;
  return {
    items: items.slice(start, start + request.pageSize),
    page,
    pageSize: request.pageSize,
    totalItems,
    totalPages,
  };
}
