import { expect, test } from "bun:test";
import { initialTranscriptMeasurements, setTranscriptMeasuredHeight, transcriptWidthBucket, type TranscriptMeasurementCacheScope } from "./transcript-measurement-cache";
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
