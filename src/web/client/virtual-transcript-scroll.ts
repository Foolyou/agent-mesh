import type { TranscriptItem } from "../types";
import { estimateTranscriptItemSize } from "./VirtualTranscript";

export const VIRTUAL_BOTTOM_THRESHOLD = 40;
export type VirtualScrollDirection = "forward" | "backward" | null;

export function isVirtualAtBottom(
  scroll: Pick<HTMLElement, "scrollHeight" | "scrollTop" | "clientHeight">,
  virtualDistanceFromEnd: number | null | undefined,
  threshold = VIRTUAL_BOTTOM_THRESHOLD,
): boolean {
  const domDelta = scroll.scrollHeight - scroll.scrollTop - scroll.clientHeight;
  return domDelta <= threshold || (typeof virtualDistanceFromEnd === "number" && virtualDistanceFromEnd <= threshold);
}

export function initialBottomOffset(items: TranscriptItem[], viewportHeight: number): number {
  const total = items.reduce((sum, item) => sum + estimateTranscriptItemSize(item), 0);
  return Math.max(0, total - viewportHeight);
}

export function shouldFollowAppend(wasAtBottom: boolean, previousCount: number, nextCount: number): boolean {
  return wasAtBottom && nextCount > previousCount;
}

export function shouldManuallyAdjustMeasuredHeight(
  delta: number,
  itemStart: number | null | undefined,
  scrollTop: number,
  scrollDirection: VirtualScrollDirection,
): boolean {
  return delta !== 0 && itemStart != null && itemStart < scrollTop && scrollDirection !== "backward";
}
