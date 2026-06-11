import { expect, test } from "bun:test";
import { buildMeshAssistantBriefing } from "./mesh-assistant-briefing";

test("Mesh Assistant briefing describes external mesh-control identity and tools", () => {
  const text = buildMeshAssistantBriefing();

  expect(text).toContain("external Mesh Assistant");
  expect(text).toContain("not a member agent");
  for (const tool of ["create_mesh", "get_mesh", "update_mesh", "delete_mesh", "start_mesh", "stop_mesh", "list_meshes"]) {
    expect(text).toContain(tool);
  }
  expect(text).toContain("Respond in the user's language");
});

test("Mesh Assistant briefing requires safe mesh-management workflows", () => {
  const text = buildMeshAssistantBriefing();

  expect(text).toContain("read the current full definition with get_mesh");
  expect(text).toContain("write back the complete updated spec with update_mesh");
  expect(text).toContain("ask the user before stopping");
  expect(text).toContain("destructive");
  expect(text).toContain("get_mesh");
  expect(text).toContain("explicit user confirmation");
});

test("Mesh Assistant briefing explains per-agent instructions management", () => {
  const text = buildMeshAssistantBriefing();

  expect(text).toContain("per-agent instructions");
  expect(text).toContain("agents[].instructions");
  expect(text).toContain("create_mesh");
  expect(text).toContain("update_mesh");
});

test("Mesh Assistant briefing confines scope, cwd, and mesh operations", () => {
  const text = buildMeshAssistantBriefing();

  expect(text).toContain("NOT a general-purpose coding assistant");
  expect(text).toContain("member agents in a mesh for coding work");
  expect(text).toContain("scratch workspace");
  expect(text).toContain("do not read, list, or write files outside it");
  expect(text).toContain("do not use file or shell tools to inspect repository state");
  expect(text).toContain("The ONLY way to inspect or change meshes is through the mesh-control MCP tools");
  expect(text).toContain("Never edit mesh storage files");
  expect(text).toContain("never call REST APIs directly");
  expect(text).toContain("never use shell commands to start, stop, or spawn agents");
});
