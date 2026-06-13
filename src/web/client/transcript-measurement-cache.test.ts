import { expect, test } from "bun:test";
import {
  getTranscriptMeasuredHeight,
  initialTranscriptMeasurements,
  setTranscriptMeasuredHeight,
  TRANSCRIPT_MEASUREMENT_CACHE_LIMIT,
  transcriptWidthBucket,
  type TranscriptMeasurementCacheScope,
} from "./transcript-measurement-cache";
import type { TranscriptItem } from "../types";

const T = "2026-06-09T00:00:00.000Z";
const SCOPE: TranscriptMeasurementCacheScope = { meshId: "mesh-a", agentId: "agent-a" };

function item(id: string): TranscriptItem {
  return { id, kind: "message", role: "agent", text: id, complete: true, ts: T };
}

test("transcriptWidthBucket rounds widths to 50px buckets", () => {
  expect(transcriptWidthBucket(0)).toBe(0);
  expect(transcriptWidthBucket(724)).toBe(700);
  expect(transcriptWidthBucket(725)).toBe(750);
});

test("initialTranscriptMeasurements reuses cached row heights by mesh, agent, item, and width bucket", () => {
  const items = [item("one"), item("two"), item("three")];
  const bucket = transcriptWidthBucket(720);
  setTranscriptMeasuredHeight(SCOPE, "two", bucket, 140);

  const measurements = initialTranscriptMeasurements(items, SCOPE, bucket, () => 50);

  expect(measurements.map((m) => m.size)).toEqual([50, 140, 50]);
  expect(measurements.map((m) => m.start)).toEqual([0, 50, 190]);
  expect(measurements.at(-1)?.end).toBe(240);
});

test("measurement cache evicts oldest entries when it reaches the limit", () => {
  const bucket = transcriptWidthBucket(720);
  for (let i = 0; i <= TRANSCRIPT_MEASUREMENT_CACHE_LIMIT; i++) {
    setTranscriptMeasuredHeight({ meshId: "lru", agentId: "agent" }, `item-${i}`, bucket, i + 1);
  }

  expect(getTranscriptMeasuredHeight({ meshId: "lru", agentId: "agent" }, "item-0", bucket)).toBeUndefined();
  expect(getTranscriptMeasuredHeight({ meshId: "lru", agentId: "agent" }, `item-${TRANSCRIPT_MEASUREMENT_CACHE_LIMIT}`, bucket)).toBe(TRANSCRIPT_MEASUREMENT_CACHE_LIMIT + 1);
});
