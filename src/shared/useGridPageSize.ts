import { useCallback, useRef, useState } from "react";

export function alignPageSizeToGrid(pageSize: number, columns: number, leadingItems = 0): number {
  const safeColumns = Math.max(1, Math.floor(columns));
  return Math.ceil((pageSize + leadingItems) / safeColumns) * safeColumns - leadingItems;
}

/** Keeps paginated grid pages on complete rows while following responsive column changes. */
export function useGridPageSize<T extends HTMLElement = HTMLElement>(pageSize: number, leadingItems = 0) {
  const observerRef = useRef<ResizeObserver | null>(null);
  const [columns, setColumns] = useState(1);

  const gridRef = useCallback((grid: T | null) => {
    observerRef.current?.disconnect();
    observerRef.current = null;
    if (!grid) return;
    const measure = () => {
      const template = getComputedStyle(grid).gridTemplateColumns;
      const count = template && template !== "none" ? template.split(/\s+/).filter(Boolean).length : 1;
      setColumns(Math.max(1, count));
    };
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(grid);
    observerRef.current = observer;
  }, []);

  return { gridRef, pageSize: alignPageSizeToGrid(pageSize, columns, leadingItems) };
}
