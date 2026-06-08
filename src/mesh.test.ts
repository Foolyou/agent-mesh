import { expect, test } from "bun:test";
import { Mesh } from "./mesh";
import { normalizeMeshEdges, type MeshConfig } from "./acp/types";

const config: MeshConfig = {
  name: "t",
  agents: [
    { id: "r", harness: "claude", project: "p", role: "router" },
    { id: "a", harness: "codex", project: "p", role: "member" },
    { id: "b", harness: "opencode", project: "p", role: "member" },
  ],
  edges: [{ from: "a", to: "b" }],
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

test("normalizes old tuple edges and new object edges", () => {
  expect(normalizeMeshEdges([["a", "b"], { from: "b", to: "a", steer: true }])).toEqual([
    { from: "a", to: "b", steer: false },
    { from: "b", to: "a", steer: true },
  ]);
});

test("canSteer respects steer flag, membership, self, and router target", () => {
  const m = new Mesh({
    ...config,
    edges: [
      { from: "a", to: "b", steer: true },
      { from: "b", to: "a" },
      { from: "a", to: "a", steer: true },
      { from: "a", to: "r", steer: true },
    ],
  });
  expect(m.canSteer("a", "b")).toBe(true);
  expect(m.canSteer("b", "a")).toBe(false);
  expect(m.canSteer("b", "r")).toBe(false);
  expect(m.canSteer("a", "a")).toBe(false);
  expect(m.canSteer("a", "r")).toBe(false);
  expect(m.canSteer("a", "z")).toBe(false);
});

test("members excludes the router", () => {
  expect(new Mesh(config).members.map((a) => a.id)).toEqual(["a", "b"]);
});

test("lazy agents default to spawning until the control plane marks them cold", () => {
  const m = new Mesh({
    ...config,
    agents: config.agents.map((a) => (a.id === "a" ? { ...a, lazy: true } : a)),
  });
  expect(m.status("a")).toBe("spawning");
  m.setStatus("a", "cold");
  expect(m.status("a")).toBe("cold");
});

test("addEdge mutates the live topology so canMail sees the new edge", () => {
  const m = new Mesh(config);
  expect(m.canMail("b", "a")).toBe(false);
  m.addEdge({ from: "b", to: "a" });
  expect(m.canMail("b", "a")).toBe(true);
  expect(m.config.edges).toContainEqual({ from: "b", to: "a", steer: false });
});
