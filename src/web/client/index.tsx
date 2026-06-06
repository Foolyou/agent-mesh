// Entry point. The real control console mounts here (Phase 8); a placeholder keeps
// the bundler entry valid until then.
import { createRoot } from "react-dom/client";

const root = document.getElementById("root");
if (root) createRoot(root).render(<div style={{ fontFamily: "monospace" }}>mesh webui — loading…</div>);
