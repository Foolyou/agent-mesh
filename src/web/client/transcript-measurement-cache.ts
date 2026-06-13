import type { VirtualItem } from "@tanstack/react-virtual";
import type { TranscriptItem } from "../types";

export type TranscriptMeasurementCacheScope = { meshId: string; agentId: string };

const measuredHeights = new Map<string, number>();

export function transcriptWidthBucket(width: number): number {
  if (!Number.isFinite(width) || width <= 0) return 0;
  return Math.round(width / 50) * 50;
}

function cacheKey(scope: TranscriptMeasurementCacheScope, itemId: string, widthBucket: number): string {
  return `${scope.meshId}:${scope.agentId}:${itemId}:${widthBucket}`;
}

export function getTranscriptMeasuredHeight(scope: TranscriptMeasurementCacheScope, itemId: string, widthBucket: number): number | undefined {
  return measuredHeights.get(cacheKey(scope, itemId, widthBucket));
}

export function setTranscriptMeasuredHeight(scope: TranscriptMeasurementCacheScope, itemId: string, widthBucket: number, height: number): void {
  if (!Number.isFinite(height) || height <= 0) return;
  measuredHeights.set(cacheKey(scope, itemId, widthBucket), height);
}

export function initialTranscriptMeasurements(
  items: TranscriptItem[],
  scope: TranscriptMeasurementCacheScope,
  widthBucket: number,
  estimateSize: (item: TranscriptItem) => number,
): VirtualItem[] {
  let start = 0;
  return items.map((item, index) => {
    const size = getTranscriptMeasuredHeight(scope, item.id, widthBucket) ?? estimateSize(item);
    const measurement: VirtualItem = { key: item.id, index, start, size, end: start + size, lane: 0 };
    start += size;
    return measurement;
  });
}
