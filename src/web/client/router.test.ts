// Step 7.0 — router foundation tests. parse/serialize are pure (no DOM), so we exercise
// prefix stripping, every surface family, view-state queries, dotted file paths, round-trip
// stability, and the non-/bnw → notFound guard.
import { test, expect } from "bun:test";
import { isBnwPath, parseBnwRoute, bnwHref, type BnwRoute } from "./router";

test("isBnwPath: only /bnw and its descendants", () => {
  expect(isBnwPath("/bnw")).toBe(true);
  expect(isBnwPath("/bnw/")).toBe(true);
  expect(isBnwPath("/bnw/mesh/alpha")).toBe(true);
  expect(isBnwPath("/")).toBe(false);
  expect(isBnwPath("/mesh/alpha")).toBe(false); // old root UI, NOT ours
  expect(isBnwPath("/bnwx")).toBe(false); // prefix must be a path boundary
  expect(isBnwPath("/__ui-mockup")).toBe(false);
});

test("parse: prefix stripping + home", () => {
  expect(parseBnwRoute("/bnw")).toEqual({ k: "home" });
  expect(parseBnwRoute("/bnw/")).toEqual({ k: "home" });
});

test("parse: runtime overview / focus / canvas / full", () => {
  expect(parseBnwRoute("/bnw/mesh/alpha")).toEqual({ k: "runtime", mesh: "alpha" });
  expect(parseBnwRoute("/bnw/mesh/alpha/agent/codex-1")).toEqual({ k: "runtime", mesh: "alpha", agent: "codex-1", full: false });
  expect(parseBnwRoute("/bnw/mesh/alpha/agent/codex-1", "?full=1")).toEqual({ k: "runtime", mesh: "alpha", agent: "codex-1", full: true });
  expect(parseBnwRoute("/bnw/mesh/alpha/canvas")).toEqual({ k: "runtime", mesh: "alpha", canvas: true });
});

test("parse: board list / kanban / issue", () => {
  expect(parseBnwRoute("/bnw/mesh/alpha/board")).toEqual({ k: "board", mesh: "alpha", view: "list" });
  expect(parseBnwRoute("/bnw/mesh/alpha/board", "?view=kanban")).toEqual({ k: "board", mesh: "alpha", view: "kanban" });
  expect(parseBnwRoute("/bnw/mesh/alpha/board/issue/12")).toEqual({ k: "board", mesh: "alpha", view: "list", issue: 12 });
  // bad issue id → not a detail route → notFound
  expect(parseBnwRoute("/bnw/mesh/alpha/board/issue/x").k).toBe("notFound");
});

test("parse: new-mesh create vs edit (reserved id)", () => {
  expect(parseBnwRoute("/bnw/mesh/new")).toEqual({ k: "newMesh" });
  expect(parseBnwRoute("/bnw/mesh/alpha/edit")).toEqual({ k: "newMesh", editOf: "alpha" });
});

test("parse: global surfaces + settings tab + assistant full", () => {
  expect(parseBnwRoute("/bnw/assistant")).toEqual({ k: "assistant", full: false });
  expect(parseBnwRoute("/bnw/assistant", "?full=1")).toEqual({ k: "assistant", full: true });
  expect(parseBnwRoute("/bnw/harnesses")).toEqual({ k: "harnesses" });
  expect(parseBnwRoute("/bnw/channels")).toEqual({ k: "channels" });
  expect(parseBnwRoute("/bnw/doctor")).toEqual({ k: "doctor" });
  expect(parseBnwRoute("/bnw/notifications")).toEqual({ k: "notifications" });
  expect(parseBnwRoute("/bnw/settings")).toEqual({ k: "settings", tab: undefined });
  expect(parseBnwRoute("/bnw/settings", "?tab=devices")).toEqual({ k: "settings", tab: "devices" });
});

test("parse: file/artifact viewer with a dotted, nested path", () => {
  expect(parseBnwRoute("/bnw/mesh/alpha/agent/codex-1/file/src/a/config.json"))
    .toEqual({ k: "file", mesh: "alpha", agent: "codex-1", kind: "file", path: "src/a/config.json", lb: false });
  expect(parseBnwRoute("/bnw/mesh/alpha/agent/codex-1/artifact/topology.png", "?lb=1"))
    .toEqual({ k: "file", mesh: "alpha", agent: "codex-1", kind: "artifact", path: "topology.png", lb: true });
});

test("parse: non-/bnw path and unknown /bnw shape → notFound", () => {
  expect(parseBnwRoute("/mesh/alpha")).toEqual({ k: "notFound", path: "/mesh/alpha" });
  expect(parseBnwRoute("/bnw/nope/deep").k).toBe("notFound");
});

test("serialize: bnwHref builds /bnw-prefixed paths", () => {
  expect(bnwHref({ k: "home" })).toBe("/bnw/");
  expect(bnwHref({ k: "runtime", mesh: "alpha" })).toBe("/bnw/mesh/alpha");
  expect(bnwHref({ k: "runtime", mesh: "alpha", agent: "codex-1", full: true })).toBe("/bnw/mesh/alpha/agent/codex-1?full=1");
  expect(bnwHref({ k: "runtime", mesh: "alpha", canvas: true })).toBe("/bnw/mesh/alpha/canvas");
  expect(bnwHref({ k: "board", mesh: "alpha", view: "kanban" })).toBe("/bnw/mesh/alpha/board?view=kanban");
  expect(bnwHref({ k: "board", mesh: "alpha", view: "list", issue: 12 })).toBe("/bnw/mesh/alpha/board/issue/12");
  expect(bnwHref({ k: "newMesh" })).toBe("/bnw/mesh/new");
  expect(bnwHref({ k: "newMesh", editOf: "alpha" })).toBe("/bnw/mesh/alpha/edit");
  expect(bnwHref({ k: "settings", tab: "devices" })).toBe("/bnw/settings?tab=devices");
  expect(bnwHref({ k: "notifications" })).toBe("/bnw/notifications");
});

test("round-trip: parse(serialize(r)) === r for representative routes", () => {
  const routes: BnwRoute[] = [
    { k: "runtime", mesh: "alpha" },
    { k: "runtime", mesh: "alpha", agent: "codex-1", full: true },
    { k: "runtime", mesh: "alpha", canvas: true },
    { k: "board", mesh: "alpha", view: "list" },
    { k: "board", mesh: "alpha", view: "kanban" },
    { k: "board", mesh: "alpha", view: "list", issue: 7 },
    { k: "newMesh" },
    { k: "newMesh", editOf: "alpha" },
    { k: "assistant", full: true },
    { k: "harnesses" }, { k: "channels" }, { k: "doctor" }, { k: "notifications" },
    { k: "settings", tab: "language" },
    { k: "file", mesh: "alpha", agent: "codex-1", kind: "artifact", path: "topology.png", lb: true },
  ];
  for (const r of routes) {
    const href = bnwHref(r);
    const [path, search] = href.split("?");
    expect(parseBnwRoute(path, search ? "?" + search : "")).toEqual(r);
  }
});
