import { expect, test } from "bun:test";
import { calcVirtualWindow } from "./VirtualList";

test("calcVirtualWindow renders only the visible rows plus overscan", () => {
  expect(calcVirtualWindow({ total: 1000, scrollTop: 500, viewportHeight: 120, rowHeight: 24, overscan: 2 })).toEqual({
    start: 18,
    end: 27,
    padTop: 432,
    padBottom: 23352,
  });
});

test("calcVirtualWindow clamps the tail near the bottom", () => {
  expect(calcVirtualWindow({ total: 10, scrollTop: 120, viewportHeight: 120, rowHeight: 24, overscan: 2 })).toEqual({
    start: 3,
    end: 10,
    padTop: 72,
    padBottom: 0,
  });
});
