import { useLayoutEffect, useRef, useState, type ReactNode } from "react";
import { measureElement as measureVirtualElement, useVirtualizer, type Rect, type Virtualizer } from "@tanstack/react-virtual";
import type { TranscriptItem } from "../types";
import { Empty } from "./ui";
import { useI18n } from "./i18n";
import { initialBottomOffset, isVirtualAtBottom, shouldFollowAppend } from "./virtual-transcript-scroll";
import {
  initialTranscriptMeasurements,
  setTranscriptMeasuredHeight,
  transcriptWidthBucket,
  type TranscriptMeasurementCacheScope,
} from "./transcript-measurement-cache";

const DEFAULT_OVERSCAN = 10;
const DEFAULT_INITIAL_RECT: Rect = { width: 720, height: 720 };

function textBucket(chars: number): number {
  if (chars <= 120) return 0;
  if (chars <= 500) return 48;
  if (chars <= 1500) return 120;
  if (chars <= 4000) return 220;
  return 360;
}

export function estimateTranscriptItemSize(item: TranscriptItem): number {
  switch (item.kind) {
    case "divider":
      return 32;
    case "message": {
      const imageExtra = item.images?.length ? Math.max(180, item.images.length * 120) : 0;
      return 80 + textBucket(item.text.length) + imageExtra;
    }
    case "thought":
      return 32;
    case "tool_call":
      return 46;
    case "mail":
      return 60;
    case "compact":
      return 32;
    case "plan":
      return 44 + item.entries.length * 24;
  }
}

export function VirtualTranscript({
  items,
  renderItem,
  cacheScope,
  overscan = DEFAULT_OVERSCAN,
  initialRect = DEFAULT_INITIAL_RECT,
  initialOffset,
}: {
  items: TranscriptItem[];
  renderItem: (item: TranscriptItem) => ReactNode;
  cacheScope?: TranscriptMeasurementCacheScope;
  overscan?: number;
  /** Test/SSR seed; real layout uses the scroll element rect. */
  initialRect?: Rect;
  initialOffset?: number;
}) {
  const { t } = useI18n();
  const parentRef = useRef<HTMLDivElement>(null);
  const stickRef = useRef(true);
  const previousCountRef = useRef(items.length);
  const measuredSizesRef = useRef(new Map<string | number, number>());
  const [stick, setStick] = useState(true);
  const [widthBucket, setWidthBucket] = useState(() => transcriptWidthBucket(initialRect.width));
  const initialMeasurementsCache =
    cacheScope && widthBucket ? initialTranscriptMeasurements(items, cacheScope, widthBucket, estimateTranscriptItemSize) : undefined;
  const virtualizer = useVirtualizer<HTMLDivElement, HTMLDivElement>({
    count: items.length,
    getScrollElement: () => parentRef.current,
    getItemKey: (index) => items[index]?.id ?? index,
    estimateSize: (index) => estimateTranscriptItemSize(items[index]!),
    initialMeasurementsCache,
    measureElement: (element: HTMLDivElement, entry: ResizeObserverEntry | undefined, instance: Virtualizer<HTMLDivElement, HTMLDivElement>) => {
      const measured = measureVirtualElement(element, entry, instance);
      const index = Number(element.getAttribute("data-index"));
      const item = Number.isInteger(index) ? items[index] : undefined;
      const key = item?.id ?? index;
      const previous = measuredSizesRef.current.get(key);
      const virtualItem = instance.getVirtualItems().find((row) => row.index === index);
      const delta = previous === undefined ? 0 : measured - previous;
      const scrollOffset = instance.scrollOffset ?? 0;
      if (delta !== 0 && virtualItem && virtualItem.start < scrollOffset) {
        const scroll = parentRef.current;
        if (scroll) scroll.scrollTop += delta;
      }
      measuredSizesRef.current.set(key, measured);
      if (cacheScope && item && widthBucket) setTranscriptMeasuredHeight(cacheScope, item.id, widthBucket, measured);
      return measured;
    },
    overscan,
    initialRect,
    initialOffset: initialOffset ?? (() => initialBottomOffset(items, initialRect.height)),
  });

  useLayoutEffect(() => {
    const el = parentRef.current;
    if (!el || typeof ResizeObserver === "undefined") return;
    const update = () => setWidthBucket(transcriptWidthBucket(el.clientWidth || el.getBoundingClientRect().width));
    update();
    const ro = new ResizeObserver(update);
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  useLayoutEffect(() => {
    const previousCount = previousCountRef.current;
    previousCountRef.current = items.length;
    if (!items.length) return;
    if (!shouldFollowAppend(stickRef.current, previousCount, items.length) && previousCount !== items.length) return;
    if (!stickRef.current) return;
    virtualizer.scrollToIndex(items.length - 1, { align: "end" });
    const raf = requestAnimationFrame(() => {
      if (stickRef.current) virtualizer.scrollToIndex(items.length - 1, { align: "end" });
    });
    return () => cancelAnimationFrame(raf);
  }, [items.length, virtualizer]);

  function noteScrollPosition() {
    const el = parentRef.current;
    if (!el) return;
    const atBottom = isVirtualAtBottom(el, virtualizer.getDistanceFromEnd());
    stickRef.current = atBottom;
    setStick(atBottom);
  }

  function jumpToBottom() {
    stickRef.current = true;
    setStick(true);
    virtualizer.scrollToIndex(items.length - 1, { align: "end" });
    parentRef.current?.focus({ preventScroll: true });
  }

  if (!items.length) return <Empty>{t("empty.messages")}</Empty>;

  return (
    <div className="stream-shell">
      <div className="stream virtual-stream" ref={parentRef} onScroll={noteScrollPosition} tabIndex={-1}>
        <div className="virtual-transcript-spacer" style={{ height: `${virtualizer.getTotalSize()}px`, position: "relative" }}>
          {virtualizer.getVirtualItems().map((virtualRow) => {
            const item = items[virtualRow.index];
            if (!item) return null;
            return (
              <div
                key={virtualRow.key}
                ref={virtualizer.measureElement}
                data-index={virtualRow.index}
                data-virtual-row="true"
                className="virtual-transcript-row"
                style={{
                  position: "absolute",
                  top: 0,
                  left: 0,
                  width: "100%",
                  transform: `translateY(${virtualRow.start}px)`,
                }}
              >
                {renderItem(item)}
              </div>
            );
          })}
        </div>
      </div>
      {!stick ? (
        <button className="jump-bottom" type="button" title={t("transcript.jumpBottom")} aria-label={t("transcript.jumpBottom")} onClick={jumpToBottom}>
          <span aria-hidden="true">↓</span>
        </button>
      ) : null}
    </div>
  );
}
