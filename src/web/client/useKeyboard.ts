// Global keyboard shortcuts. Web-adapted from the TUI keymap: Ctrl-R/Ctrl-F/Tab are
// reserved by the browser, so we use non-conflicting keys and keep buttons for every
// action. Typing in inputs is never intercepted (except Esc, to close overlays).
import { useEffect, useRef } from "react";

export interface KeyHandlers {
  onPrev(): void; // ↑  select previous mesh
  onNext(): void; // ↓  select next mesh
  onReload(): void; // r  reload definitions
  onToggleFull(): void; // f  fullscreen router chat
  onNewMesh(): void; // n  new-mesh form
  onEsc(): void; // esc close overlay / exit fullscreen / deselect
  onDigit(index: number): void; // 1-9 resolve pending permission option
}

export function useKeyboard(handlers: KeyHandlers): void {
  const ref = useRef(handlers);
  ref.current = handlers;
  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      const t = e.target as HTMLElement | null;
      const tag = t?.tagName;
      const typing = tag === "INPUT" || tag === "SELECT" || tag === "TEXTAREA";
      const h = ref.current;
      if (e.key === "Escape") {
        h.onEsc();
        return;
      }
      if (typing || e.metaKey || e.ctrlKey || e.altKey) return;
      if (e.key === "ArrowDown") {
        e.preventDefault();
        h.onNext();
      } else if (e.key === "ArrowUp") {
        e.preventDefault();
        h.onPrev();
      } else if (e.key === "r") {
        h.onReload();
      } else if (e.key === "f") {
        h.onToggleFull();
      } else if (e.key === "n") {
        h.onNewMesh();
      } else if (/^[1-9]$/.test(e.key)) {
        h.onDigit(Number(e.key) - 1);
      }
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);
}
