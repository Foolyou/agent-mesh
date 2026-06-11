// Entry point: mount the control console.
import { createRoot } from "react-dom/client";
import "./theme.css";
import { initTheme } from "./themes";
import { installVisualViewportHeightVar } from "./viewport";
import { App } from "./App";

initTheme(); // apply the persisted theme before first paint (no flash)
installVisualViewportHeightVar({ window, target: document.documentElement });

const root = document.getElementById("root");
if (root) createRoot(root).render(<App />);
