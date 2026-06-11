import { test, expect } from "bun:test";
import { installVisualViewportHeightVar, viewportHeightCssValue } from "./viewport";

test("viewportHeightCssValue prefers the visual viewport height", () => {
  expect(viewportHeightCssValue({ innerHeight: 900, visualViewport: { height: 512 } })).toBe("512px");
  expect(viewportHeightCssValue({ innerHeight: 900 })).toBe("900px");
});

test("installVisualViewportHeightVar tracks visual viewport resize and scroll", () => {
  const calls: Array<[string, string]> = [];
  const listeners: Record<string, Array<() => void>> = {};
  const frames: Array<() => void> = [];
  const visualViewport = {
    height: 700,
    addEventListener: (name: string, fn: () => void) => {
      (listeners[name] ??= []).push(fn);
    },
    removeEventListener: (name: string, fn: () => void) => {
      listeners[name] = (listeners[name] ?? []).filter((entry) => entry !== fn);
    },
  };
  const cleanup = installVisualViewportHeightVar({
    window: {
      innerHeight: 900,
      visualViewport,
      requestAnimationFrame: (fn: () => void) => {
        frames.push(fn);
        return frames.length;
      },
    },
    target: { style: { setProperty: (name: string, value: string) => calls.push([name, value]) } },
  });

  expect(calls.at(-1)).toEqual(["--mesh-vvh", "700px"]);
  visualViewport.height = 520;
  listeners.resize[0]();
  expect(calls.at(-1)).toEqual(["--mesh-vvh", "700px"]);
  visualViewport.height = 500;
  listeners.scroll[0]();
  expect(frames).toHaveLength(1);
  frames.shift()?.();
  expect(calls.at(-1)).toEqual(["--mesh-vvh", "500px"]);

  cleanup();
  visualViewport.height = 480;
  listeners.resize[0]?.();
  expect(calls.at(-1)).toEqual(["--mesh-vvh", "500px"]);
});

test("installVisualViewportHeightVar falls back to window resize without visualViewport", () => {
  const calls: Array<[string, string]> = [];
  const listeners: Record<string, Array<() => void>> = {};
  const frames: Array<() => void> = [];
  const win = {
    innerHeight: 900,
    requestAnimationFrame: (fn: () => void) => {
      frames.push(fn);
      return frames.length;
    },
    addEventListener: (name: string, fn: () => void) => {
      (listeners[name] ??= []).push(fn);
    },
    removeEventListener: (name: string, fn: () => void) => {
      listeners[name] = (listeners[name] ?? []).filter((entry) => entry !== fn);
    },
  };
  const cleanup = installVisualViewportHeightVar({
    window: win,
    target: { style: { setProperty: (name: string, value: string) => calls.push([name, value]) } },
  });

  expect(calls.at(-1)).toEqual(["--mesh-vvh", "900px"]);
  win.innerHeight = 640;
  listeners.resize[0]();
  expect(calls.at(-1)).toEqual(["--mesh-vvh", "900px"]);
  frames.shift()?.();
  expect(calls.at(-1)).toEqual(["--mesh-vvh", "640px"]);

  cleanup();
  win.innerHeight = 620;
  listeners.resize[0]?.();
  expect(calls.at(-1)).toEqual(["--mesh-vvh", "640px"]);
});
