import { test, expect } from "bun:test";
import { installVisualViewportHeightVar, viewportHeightCssValue, viewportTopCssValue } from "./viewport";

// last value written for a given custom property, so assertions don't depend on
// the relative order in which --mesh-vvh / --mesh-vvtop are flushed inside apply().
function lastValue(calls: Array<[string, string]>, name: string): string | undefined {
  return calls.filter(([n]) => n === name).at(-1)?.[1];
}

test("viewportHeightCssValue prefers the visual viewport height", () => {
  expect(viewportHeightCssValue({ innerHeight: 900, visualViewport: { height: 512 } })).toBe("512px");
  expect(viewportHeightCssValue({ innerHeight: 900 })).toBe("900px");
});

test("viewportTopCssValue follows the visual viewport offsetTop and defaults to 0px", () => {
  expect(viewportTopCssValue({ innerHeight: 900, visualViewport: { height: 512, offsetTop: 64 } })).toBe("64px");
  // no offsetTop on the visual viewport → treated as pinned to the top
  expect(viewportTopCssValue({ innerHeight: 900, visualViewport: { height: 512 } })).toBe("0px");
  // no visual viewport at all → 0px
  expect(viewportTopCssValue({ innerHeight: 900 })).toBe("0px");
});

test("installVisualViewportHeightVar tracks visual viewport height and offsetTop", () => {
  const calls: Array<[string, string]> = [];
  const listeners: Record<string, Array<() => void>> = {};
  const frames: Array<() => void> = [];
  const visualViewport = {
    height: 700,
    offsetTop: 0,
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

  // initial synchronous apply writes both vars
  expect(lastValue(calls, "--mesh-vvh")).toBe("700px");
  expect(lastValue(calls, "--mesh-vvtop")).toBe("0px");

  // resize is coalesced through rAF — no eager write
  visualViewport.height = 520;
  listeners.resize[0]();
  expect(lastValue(calls, "--mesh-vvh")).toBe("700px");

  // keyboard up: viewport shrinks AND shifts down (offsetTop > 0)
  visualViewport.height = 500;
  visualViewport.offsetTop = 48;
  listeners.scroll[0]();
  expect(frames).toHaveLength(1);
  frames.shift()?.();
  expect(lastValue(calls, "--mesh-vvh")).toBe("500px");
  expect(lastValue(calls, "--mesh-vvtop")).toBe("48px");

  // keyboard dismissed / address bar settles: offsetTop must return to 0 with no residual offset
  visualViewport.height = 900;
  visualViewport.offsetTop = 0;
  listeners.resize[0]();
  frames.shift()?.();
  expect(lastValue(calls, "--mesh-vvh")).toBe("900px");
  expect(lastValue(calls, "--mesh-vvtop")).toBe("0px");

  cleanup();
  visualViewport.height = 480;
  visualViewport.offsetTop = 30;
  listeners.resize[0]?.();
  expect(lastValue(calls, "--mesh-vvh")).toBe("900px");
  expect(lastValue(calls, "--mesh-vvtop")).toBe("0px");
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

  expect(lastValue(calls, "--mesh-vvh")).toBe("900px");
  // no visual viewport → offsetTop is always pinned to 0px
  expect(lastValue(calls, "--mesh-vvtop")).toBe("0px");
  win.innerHeight = 640;
  listeners.resize[0]();
  expect(lastValue(calls, "--mesh-vvh")).toBe("900px");
  frames.shift()?.();
  expect(lastValue(calls, "--mesh-vvh")).toBe("640px");
  expect(lastValue(calls, "--mesh-vvtop")).toBe("0px");

  cleanup();
  win.innerHeight = 620;
  listeners.resize[0]?.();
  expect(lastValue(calls, "--mesh-vvh")).toBe("640px");
});
