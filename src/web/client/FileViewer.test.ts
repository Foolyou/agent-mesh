import { test, expect } from "bun:test";
import { parseFileRoute } from "./FileViewer";

test("parseFileRoute recognizes worktree file viewer routes", () => {
  expect(parseFileRoute("/mesh/dev/agent/codex-1/file/report.md")).toEqual({
    meshId: "dev",
    agentName: "codex-1",
    kind: "file",
    path: "report.md",
  });
});

test("parseFileRoute recognizes artifact viewer routes", () => {
  expect(parseFileRoute("/mesh/dev/agent/builder/artifact/docs/a%20b.md")).toEqual({
    meshId: "dev",
    agentName: "builder",
    kind: "artifact",
    path: "docs/a%20b.md",
  });
});
