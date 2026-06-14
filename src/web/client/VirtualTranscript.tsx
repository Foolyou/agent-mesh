import { useLayoutEffect, useRef, useState, type ReactNode } from "react";
import { measureElement as measureVirtualElement, useVirtualizer, type Rect, type Virtualizer } from "@tanstack/react-virtual";
import type { TranscriptItem } from "../types";
import { Empty } from "./ui";
import { useI18n } from "./i18n";
import { initialBottomOffset, isVirtualAtBottom, shouldFollowAppend, shouldManuallyAdjustMeasuredHeight, type VirtualScrollDirection } from "./virtual-transcript-scroll";
import { didTranscriptScrollUp, isTranscriptScrollIntentKey, nextTranscriptStickState } from "./Transcript";
import {
  initialTranscriptMeasurements,
  setTranscriptMeasuredHeight,
  transcriptWidthBucket,
  type TranscriptMeasurementCacheScope,
} from "./transcript-measurement-cache";

const DEFAULT_OVERSCAN = 10;
const DEFAULT_INITIAL_RECT: Rect = { width: 720, height: 720 };
const OVERSCAN_NEAR_TOP = 20;
type VirtualizerOptionsWithCompensationGuard = Parameters<typeof useVirtualizer<HTMLDivElement, HTMLDivElement>>[0] & {
  shouldAdjustScrollPositionOnItemSizeChange: () => false;
};

export function shouldTriggerTranscriptBackfill({
  firstVisibleIndex,
  hasMore,
  inflight,
}: {
  firstVisibleIndex: number | undefined;
  hasMore: boolean | undefined;
  inflight: boolean;
}): boolean {
  return hasMore === true && !inflight && firstVisibleIndex !== undefined && firstVisibleIndex < OVERSCAN_NEAR_TOP;
}

export function preservePrependAnchorOffset({
  currentStart,
  previousTop,
  containerTop,
}: {
  currentStart: number;
  previousTop: number;
  containerTop: number;
}): number {
  return Math.max(0, currentStart - (previousTop - containerTop));
}

export function shouldShowOlderTranscriptMarker(hasMore: boolean | undefined, firstVisibleIndex: number | undefined): boolean {
  return hasMore === true && firstVisibleIndex === 0;
}

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
    case "attachment":
      // Image cards render a thumbnail; document cards are a single link row.
      return (item.contentType.startsWith("image/") ? 220 : 48) + (item.caption ? 24 : 0);
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
  hasMore,
  activeId,
  onLoadOlder,
}: {
  items: TranscriptItem[];
  renderItem: (item: TranscriptItem) => ReactNode;
  cacheScope?: TranscriptMeasurementCacheScope;
  overscan?: number;
  /** Test/SSR seed; real layout uses the scroll element rect. */
  initialRect?: Rect;
  initialOffset?: number;
  hasMore?: boolean;
  activeId?: string;
  onLoadOlder?: () => Promise<void>;
}) {
  const { t } = useI18n();
  const parentRef = useRef<HTMLDivElement>(null);
  const stickRef = useRef(true);
  const previousCountRef = useRef(items.length);
  const measuredSizesRef = useRef(new Map<string | number, number>());
  const previousScrollTopRef = useRef<number | null>(null);
  const scrollDirectionRef = useRef<VirtualScrollDirection>(null);
  const userScrollIntentRef = useRef(false);
  const userScrollIntentTimerRef = useRef<number | undefined>(undefined);
  const loadingOlderRef = useRef(false);
  const backfillScrollTokenRef = useRef(0);
  const consumedBackfillScrollTokenRef = useRef(0);
  const backfillBlockedAtTopRef = useRef(false);
  const prependAnchorRef = useRef<{ id: string; top: number; containerTop: number } | null>(null);
  const previousFirstItemIdRef = useRef(items[0]?.id);
  const [stick, setStick] = useState(true);
  const [loadingOlder, setLoadingOlder] = useState(false);
  const [firstVisibleIndex, setFirstVisibleIndex] = useState<number | undefined>(undefined);
  const [widthBucket, setWidthBucket] = useState(() => transcriptWidthBucket(initialRect.width));
  const initialMeasurementsCache =
    cacheScope && widthBucket ? initialTranscriptMeasurements(items, cacheScope, widthBucket, estimateTranscriptItemSize) : undefined;
  const virtualizer = useVirtualizer<HTMLDivElement, HTMLDivElement>({
    count: items.length,
    getScrollElement: () => parentRef.current,
    getItemKey: (index) => items[index]?.id ?? index,
    estimateSize: (index) => estimateTranscriptItemSize(items[index]!),
    initialMeasurementsCache,
    // Explicitly disable library default scroll compensation. Our manual
    // measureElement-based compensation is the single owner; this guard
    // protects against future @tanstack/react-virtual minor versions
    // making the library default start firing (= 2x delta double compensation).
    // See #28 / reviewer mail #258 for context.
    shouldAdjustScrollPositionOnItemSizeChange: () => false,
    measureElement: (element: HTMLDivElement, entry: ResizeObserverEntry | undefined, instance: Virtualizer<HTMLDivElement, HTMLDivElement>) => {
      const measured = measureVirtualElement(element, entry, instance);
      const index = Number(element.getAttribute("data-index"));
      const item = Number.isInteger(index) ? items[index] : undefined;
      const key = item?.id ?? index;
      const previous = measuredSizesRef.current.get(key);
      const virtualItem = instance.getVirtualItems().find((row) => row.index === index);
      const delta = previous === undefined ? 0 : measured - previous;
      const scroll = parentRef.current;
      // TanStack's default resize adjustment does not fire for this overscan +
      // custom measureElement path in our e2e. Keep a local compensation, but
      // mirror TanStack's backward-scroll guard to avoid upward-scroll jank.
      if (scroll && shouldManuallyAdjustMeasuredHeight(delta, virtualItem?.start, scroll.scrollTop, scrollDirectionRef.current)) {
        scroll.scrollTop += delta;
        previousScrollTopRef.current = scroll.scrollTop;
      }
      measuredSizesRef.current.set(key, measured);
      if (cacheScope && item && widthBucket) setTranscriptMeasuredHeight(cacheScope, item.id, widthBucket, measured);
      return measured;
    },
    overscan,
    initialRect,
    initialOffset: initialOffset ?? (() => initialBottomOffset(items, initialRect.height)),
  } as VirtualizerOptionsWithCompensationGuard);

  function syncPreviousScrollTop() {
    const el = parentRef.current;
    if (el) previousScrollTopRef.current = el.scrollTop;
  }

  function markUserScrollIntent() {
    syncPreviousScrollTop();
    userScrollIntentRef.current = true;
    if (userScrollIntentTimerRef.current !== undefined) window.clearTimeout(userScrollIntentTimerRef.current);
    userScrollIntentTimerRef.current = window.setTimeout(() => {
      userScrollIntentRef.current = false;
      userScrollIntentTimerRef.current = undefined;
    }, 350);
  }

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
    syncPreviousScrollTop();
    const raf = requestAnimationFrame(() => {
      if (stickRef.current) {
        virtualizer.scrollToIndex(items.length - 1, { align: "end" });
        syncPreviousScrollTop();
      }
    });
    return () => cancelAnimationFrame(raf);
  }, [items.length, virtualizer]);
  useLayoutEffect(() => {
    stickRef.current = true;
    setStick(true);
    if (items.length) {
      virtualizer.scrollToIndex(items.length - 1, { align: "end" });
      syncPreviousScrollTop();
      const raf = requestAnimationFrame(() => {
        virtualizer.scrollToIndex(items.length - 1, { align: "end" });
        syncPreviousScrollTop();
      });
      return () => cancelAnimationFrame(raf);
    }
  }, [activeId]);
  useLayoutEffect(() => {
    const previousFirstItemId = previousFirstItemIdRef.current;
    previousFirstItemIdRef.current = items[0]?.id;
    if (previousFirstItemId === items[0]?.id) return;
    const anchor = prependAnchorRef.current;
    if (!anchor) return;
    const index = items.findIndex((item) => item.id === anchor.id);
    if (index < 0) return;
    const raf = requestAnimationFrame(() => {
      let attempts = 0;
      const adjust = () => {
        attempts += 1;
        const scroll = parentRef.current;
        const row = scroll?.querySelector<HTMLElement>(`[data-item-id="${CSS.escape(anchor.id)}"]`);
        if (!scroll || !row) {
          virtualizer.scrollToIndex(index, { align: "start" });
          if (attempts < 6) requestAnimationFrame(adjust);
          return;
        }
        const delta = row.getBoundingClientRect().top - anchor.top;
        scroll.scrollTop += delta;
        syncPreviousScrollTop();
        if (Math.abs(delta) >= 1 && attempts < 6) {
          requestAnimationFrame(adjust);
          return;
        }
        prependAnchorRef.current = null;
      };
      adjust();
    });
    return () => cancelAnimationFrame(raf);
  }, [items, virtualizer]);
  useLayoutEffect(() => {
    return () => {
      if (userScrollIntentTimerRef.current !== undefined) window.clearTimeout(userScrollIntentTimerRef.current);
    };
  }, []);

  function noteScrollPosition() {
    const el = parentRef.current;
    if (!el) return;
    const scrollTop = el.scrollTop;
    const previous = previousScrollTopRef.current;
    const wentUp = didTranscriptScrollUp(scrollTop, previous ?? scrollTop);
    if (previous != null && scrollTop !== previous) {
      scrollDirectionRef.current = scrollTop > previous ? "forward" : "backward";
    }
    previousScrollTopRef.current = scrollTop;
    const firstVisible = virtualizer.getVirtualItems()[0]?.index;
    if (firstVisible !== 0) backfillBlockedAtTopRef.current = false;
    const atBottom = isVirtualAtBottom(el, virtualizer.getDistanceFromEnd());
    const nextStick = nextTranscriptStickState(stickRef.current, atBottom, userScrollIntentRef.current, wentUp);
    stickRef.current = nextStick;
    setStick(nextStick);
    backfillScrollTokenRef.current += 1;
    maybeLoadOlder();
  }

  function captureTopAnchor(): void {
    const el = parentRef.current;
    if (!el) return;
    const streamBox = el.getBoundingClientRect();
    const row = [...el.querySelectorAll<HTMLElement>("[data-virtual-row='true']")].find((candidate) => {
      const box = candidate.getBoundingClientRect();
      return box.bottom > streamBox.top && box.top < streamBox.bottom;
    });
    const index = row ? Number(row.getAttribute("data-index")) : undefined;
    const item = Number.isInteger(index) ? items[index!] : undefined;
    if (!item) return;
    prependAnchorRef.current = {
      id: item.id,
      top: row?.getBoundingClientRect().top ?? streamBox.top,
      containerTop: streamBox.top,
    };
  }

  function maybeLoadOlder() {
    if (!shouldTriggerTranscriptBackfill({ firstVisibleIndex: virtualizer.getVirtualItems()[0]?.index, hasMore, inflight: loadingOlderRef.current })) return;
    if (!onLoadOlder) return;
    if (backfillBlockedAtTopRef.current) return;
    if (consumedBackfillScrollTokenRef.current === backfillScrollTokenRef.current) return;
    consumedBackfillScrollTokenRef.current = backfillScrollTokenRef.current;
    backfillBlockedAtTopRef.current = true;
    captureTopAnchor();
    loadingOlderRef.current = true;
    setLoadingOlder(true);
    void onLoadOlder().finally(() => {
      loadingOlderRef.current = false;
      setLoadingOlder(false);
    });
  }

  useLayoutEffect(() => {
    setFirstVisibleIndex(virtualizer.getVirtualItems()[0]?.index);
  });

  function jumpToBottom() {
    stickRef.current = true;
    setStick(true);
    virtualizer.scrollToIndex(items.length - 1, { align: "end" });
    syncPreviousScrollTop();
    parentRef.current?.focus({ preventScroll: true });
  }

  if (!items.length) return <Empty>{t("empty.messages")}</Empty>;

  return (
    <div className="stream-shell">
      <div
        className="stream virtual-stream"
        ref={parentRef}
        onScroll={noteScrollPosition}
        onWheel={markUserScrollIntent}
        onTouchMove={markUserScrollIntent}
        onKeyDown={(e) => {
          if (isTranscriptScrollIntentKey(e.key)) markUserScrollIntent();
        }}
        tabIndex={-1}
      >
        {shouldShowOlderTranscriptMarker(hasMore, firstVisibleIndex ?? virtualizer.getVirtualItems()[0]?.index) ? (
          <div className="virtual-transcript-loading" aria-live="polite">
            {loadingOlder ? "Loading older..." : "Scroll up for older messages"}
          </div>
        ) : null}
        <div className="virtual-transcript-spacer" style={{ height: `${virtualizer.getTotalSize()}px`, position: "relative" }}>
          {virtualizer.getVirtualItems().map((virtualRow) => {
            const item = items[virtualRow.index];
            if (!item) return null;
            return (
              <div
                key={virtualRow.key}
                ref={virtualizer.measureElement}
                data-index={virtualRow.index}
                data-item-id={item.id}
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
