// Hardwired demo mesh for the PoC. All agents run in the test_mesh_0/ project.
// Router (gateway) = claude; members = codex + opencode. Members may mail each
// other and the router may mail either member.
import type { MeshConfig } from "./acp/types";

export const DEMO_MESH: MeshConfig = {
  name: "demo",
  agents: [
    { id: "router", harness: "claude", project: "test_mesh_0", role: "router" },
    { id: "codex-1", harness: "codex", project: "test_mesh_0", role: "member" },
    { id: "opencode-1", harness: "opencode", project: "test_mesh_0", role: "member" },
  ],
  edges: [
    { from: "codex-1", to: "opencode-1" },
    { from: "opencode-1", to: "codex-1" },
    { from: "router", to: "codex-1" },
    { from: "router", to: "opencode-1" },
  ],
};
