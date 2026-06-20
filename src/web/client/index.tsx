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
// Boot gates on device authorization before mounting the console (and opening the WS).
if (root) createRoot(root).render(<Boot />);
