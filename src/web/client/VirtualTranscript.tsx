import { useRef, type ReactNode } from "react";
import { useVirtualizer, type Rect } from "@tanstack/react-virtual";
import type { TranscriptItem } from "../types";
import { Empty } from "./ui";
import { useI18n } from "./i18n";

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
  overscan = DEFAULT_OVERSCAN,
  initialRect = DEFAULT_INITIAL_RECT,
  initialOffset = 0,
}: {
  items: TranscriptItem[];
  renderItem: (item: TranscriptItem) => ReactNode;
  overscan?: number;
  /** Test/SSR seed; real layout uses the scroll element rect. */
  initialRect?: Rect;
  initialOffset?: number;
}) {
  const { t } = useI18n();
  const parentRef = useRef<HTMLDivElement>(null);
  const virtualizer = useVirtualizer<HTMLDivElement, HTMLDivElement>({
    count: items.length,
    getScrollElement: () => parentRef.current,
    getItemKey: (index) => items[index]?.id ?? index,
    estimateSize: (index) => estimateTranscriptItemSize(items[index]!),
    overscan,
    initialRect,
    initialOffset,
  });

  if (!items.length) return <Empty>{t("empty.messages")}</Empty>;

  return (
    <div className="stream-shell">
      <div className="stream virtual-stream" ref={parentRef} tabIndex={-1}>
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
    </div>
  );
}
