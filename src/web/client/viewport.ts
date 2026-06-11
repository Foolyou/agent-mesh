type ViewportLike = {
  innerHeight: number;
  requestAnimationFrame?: (listener: () => void) => number;
  addEventListener?: (name: "resize", listener: () => void) => void;
  removeEventListener?: (name: "resize", listener: () => void) => void;
  visualViewport?: {
    height: number;
    addEventListener?: (name: "resize" | "scroll", listener: () => void) => void;
    removeEventListener?: (name: "resize" | "scroll", listener: () => void) => void;
  } | null;
};

type StyleTarget = {
  style: {
    setProperty: (name: string, value: string) => void;
  };
};

export function viewportHeightCssValue(win: ViewportLike): string {
  return `${Math.round(win.visualViewport?.height ?? win.innerHeight)}px`;
}

export function installVisualViewportHeightVar({
  window: win,
  target,
}: {
  window: ViewportLike;
  target: StyleTarget;
}): () => void {
  let queued = false;
  let disposed = false;
  const apply = () => target.style.setProperty("--mesh-vvh", viewportHeightCssValue(win));
  const update = () => {
    if (queued || disposed) return;
    queued = true;
    const raf = win.requestAnimationFrame ?? ((fn: () => void) => (setTimeout(fn, 0), 0));
    raf(() => {
      queued = false;
      if (!disposed) apply();
    });
  };
  const visualViewport = win.visualViewport;
  apply();
  win.addEventListener?.("resize", update);
  visualViewport?.addEventListener?.("resize", update);
  visualViewport?.addEventListener?.("scroll", update);
  return () => {
    disposed = true;
    win.removeEventListener?.("resize", update);
    visualViewport?.removeEventListener?.("resize", update);
    visualViewport?.removeEventListener?.("scroll", update);
  };
}
