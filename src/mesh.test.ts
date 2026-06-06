import { expect, test } from "bun:test";
import { Mesh } from "./mesh";
import type { MeshConfig } from "./acp/types";

const config: MeshConfig = {
  name: "t",
  agents: [
    { id: "r", harness: "claude", project: "p", role: "router" },
    { id: "a", harness: "codex", project: "p", role: "member" },
    { id: "b", harness: "opencode", project: "p", role: "member" },
  ],
  edges: [["a", "b"]],
};

test("router is the role=router agent", () => {
  expect(new Mesh(config).router.id).toBe("r");
});

test("canMail respects directed edges and membership", () => {
  const m = new Mesh(config);
  expect(m.canMail("a", "b")).toBe(true);
  expect(m.canMail("b", "a")).toBe(false);
  expect(m.canMail("a", "z")).toBe(false);
});

test("members excludes the router", () => {
  expect(new Mesh(config).members.map((a) => a.id)).toEqual(["a", "b"]);
});
