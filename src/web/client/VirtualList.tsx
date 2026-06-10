import { useLayoutEffect, useMemo, useRef, useState, type CSSProperties, type ReactNode } from "react";

export interface VirtualWindowInput {
  total: number;
  scrollTop: number;
  viewportHeight: number;
  rowHeight: number;
  overscan?: number;
}

export function calcVirtualWindow(input: VirtualWindowInput): { start: number; end: number; padTop: number; padBottom: number } {
  const rowHeight = Math.max(1, input.rowHeight);
  const overscan = input.overscan ?? 4;
  const visible = Math.ceil(Math.max(0, input.viewportHeight) / rowHeight);
  const maxStart = Math.max(0, input.total - 1);
  const rawStart = Math.floor(Math.max(0, input.scrollTop) / rowHeight) - overscan;
  const start = Math.min(maxStart, Math.max(0, rawStart));
  const end = Math.min(input.total, start + visible + overscan * 2);
  return {
    start,
    end,
    padTop: start * rowHeight,
    padBottom: Math.max(0, (input.total - end) * rowHeight),
  };
}

export function VirtualList<T>({
  items,
  rowHeight = 26,
  overscan = 6,
  className,
  style,
  empty,
  render,
}: {
  items: T[];
  rowHeight?: number;
  overscan?: number;
  className?: string;
  style?: CSSProperties;
  empty: ReactNode;
  render: (item: T) => ReactNode;
}) {
  const ref = useRef<HTMLDivElement | null>(null);
  const [viewport, setViewport] = useState({ scrollTop: 0, height: 0 });

  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const update = () => setViewport({ scrollTop: el.scrollTop, height: el.clientHeight });
    update();
    if (typeof ResizeObserver === "undefined") return;
    const ro = new ResizeObserver(update);
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  const win = useMemo(
    () => calcVirtualWindow({ total: items.length, scrollTop: viewport.scrollTop, viewportHeight: viewport.height, rowHeight, overscan }),
    [items.length, overscan, rowHeight, viewport.height, viewport.scrollTop],
  );
  const visible = items.slice(win.start, win.end);

  if (!items.length) return <>{empty}</>;
  return (
    <div
      ref={ref}
      className={`virtual-list ${className ?? ""}`}
      style={style}
      onScroll={(event) => setViewport({ scrollTop: event.currentTarget.scrollTop, height: event.currentTarget.clientHeight })}
    >
      <div style={{ paddingTop: win.padTop, paddingBottom: win.padBottom }}>
        <div className="virtual-list-window">{visible.map(render)}</div>
      </div>
    </div>
  );
}
