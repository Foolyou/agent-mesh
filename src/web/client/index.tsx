// Entry point: mount the control console.
import { createRoot } from "react-dom/client";
// Tailwind v4 (layered: preflight/utilities) loads BEFORE the legacy stylesheet so
// the UNLAYERED theme.css outranks it during the incremental migration — see tailwind.css.
import "./tailwind.css";
import "./theme.css";
import { initTheme } from "./themes";
import { installVisualViewportHeightVar } from "./viewport";
import { Boot } from "./Boot";

initTheme(); // apply the persisted theme before first paint (no flash)
installVisualViewportHeightVar({ window, target: document.documentElement });

const root = document.getElementById("root");
// Isolated design preview (Step 5, pre-C5): /__ui-preview mounts a standalone token
// preview INSTEAD of the console when the server explicitly exposes that route
// (MESH_UI_PREVIEW=1). It never opens the WS / store / device-auth, so it cannot
// disrupt business flows. Dynamically imported so it's only loaded on that route.
// Remove this branch + UiPreview.tsx + the server route when C5 lands.
if (root) {
  if (window.location.pathname.startsWith("/__ui-preview")) {
    import("./UiPreview").then(({ UiPreview }) => createRoot(root).render(<UiPreview />));
  } else {
    // Boot gates on device authorization before mounting the console (and opening the WS).
    createRoot(root).render(<Boot />);
  }
}
