// Entry point: mount the control console.
import { createRoot } from "react-dom/client";
import "./theme.css";
import { initTheme } from "./themes";
import { installVisualViewportHeightVar } from "./viewport";
import { Boot } from "./Boot";

initTheme(); // apply the persisted theme before first paint (no flash)
installVisualViewportHeightVar({ window, target: document.documentElement });

const root = document.getElementById("root");
// Boot gates on device authorization before mounting the console (and opening the WS).
if (root) createRoot(root).render(<Boot />);
