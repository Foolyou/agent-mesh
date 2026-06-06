// Entry point: mount the control console.
import { createRoot } from "react-dom/client";
import "./theme.css";
import { App } from "./App";

const root = document.getElementById("root");
if (root) createRoot(root).render(<App />);
