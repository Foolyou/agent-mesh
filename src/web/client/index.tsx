// Entry point: mount the control console.
import { createRoot } from "react-dom/client";
// Tailwind v4 (layered: preflight/utilities) loads BEFORE the legacy stylesheet so
// the UNLAYERED theme.css outranks it during the incremental migration — see tailwind.css.
import "./tailwind.css";
import "./theme.css";
import { initTheme } from "./themes";
import { installVisualViewportHeightVar } from "./viewport";
import { Boot } from "./Boot";
import { isBnwPath } from "./router";

initTheme(); // apply the persisted theme before first paint (no flash)
installVisualViewportHeightVar({ window, target: document.documentElement });

const root = document.getElementById("root");
// Isolated design routes, mounted INSTEAD of the console only when the server
// explicitly exposes them (MESH_UI_PREVIEW=1): /__ui-preview = the C8 component
// gallery; /__ui-mockup = the Step 6 high-fidelity page mockups. Neither opens the
// WS / store / device-auth, so they cannot disrupt business flows. Dynamically
// imported so they're only loaded on their route. Remove these branches + the
// UiPreview/UiMockup files + the server routes to retire them.
if (root) {
  if (window.location.pathname.startsWith("/__ui-preview")) {
    import("./UiPreview").then(({ UiPreview }) => createRoot(root).render(<UiPreview />));
  } else if (window.location.pathname.startsWith("/__ui-mockup")) {
    import("./UiMockup").then(({ UiMockup }) => createRoot(root).render(<UiMockup />));
  } else if (isBnwPath(window.location.pathname)) {
    // Step 7.0 — the new `/bnw/` console (parallel namespace). Same device-auth Boot gate,
    // a separate view tree; the old root UI below is untouched. Dynamically imported so the
    // new shell only loads on `/bnw/` paths.
    import("./bnw/BnwApp").then(({ BnwApp }) => createRoot(root).render(<Boot><BnwApp /></Boot>));
  } else {
    // Boot gates on device authorization before mounting the console (and opening the WS).
    createRoot(root).render(<Boot />);
  }
}
