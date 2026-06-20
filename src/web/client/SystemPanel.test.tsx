import { expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { createElement } from "react";
import { SystemPanel, DoctorSection, ProcessSection } from "./SystemPanel";
import type { DoctorReport, PsDetail } from "../types";
import type { Store } from "./store";

test("SystemPanel renders the gated dialog shell with accessible refresh control", () => {
  const store = { fetchDoctor: async () => null, fetchPsDetail: async () => null } as unknown as Store;
  const html = renderToStaticMarkup(createElement(SystemPanel, { store, open: true, onClose: () => {} }));
  expect(html).toContain("System health");
  expect(html).toContain('role="dialog"');
  expect(html).toContain('aria-label="Refresh system status"');
});

test("SystemPanel renders nothing when closed", () => {
  const store = {} as unknown as Store;
  expect(renderToStaticMarkup(createElement(SystemPanel, { store, open: false, onClose: () => {} }))).toBe("");
});

test("DoctorSection conveys severity by text (not colour alone) and shows fix hints only when not ok", () => {
  const report: DoctorReport = {
    checks: [
      { id: "harness.codex", severity: "ok", ok: true, detail: "adapter 1.2.3, core 0.1" },
      { id: "config.meshes", severity: "warning", ok: false, detail: "demo.json: duplicate agent id", fixHint: "fix the mesh config" },
      { id: "service.backend", severity: "error", ok: false, detail: "backend not healthy", fixHint: "start the backend" },
    ],
    summary: { total: 3, ok: 1, warnings: 1, errors: 1, worst: "error" },
  };
  const html = renderToStaticMarkup(createElement(DoctorSection, { report }));
  // severity word is present in text for each check (accessibility: not colour-only)
  expect(html).toContain("warning");
  expect(html).toContain("error");
  expect(html).toContain("worst: error");
  // fix hint shown for the failing checks, and the ok check carries no fix line
  expect(html).toContain("fix: fix the mesh config");
  expect(html).toContain("fix: start the backend");
  expect(html.match(/fix:/g)?.length).toBe(2);
});

test("ProcessSection lists running meshes, live agents, and leaks; never prints a raw token", () => {
  const ps: PsDetail = {
    running: [
      { name: "demo", pid: 4321, socketPath: "/run/demo.sock", agents: [
        { id: "router", harness: "claude", role: "router", activity: "working", contextPercent: 25, contextUsed: 50, contextSize: 200 },
        { id: "m1", harness: "codex", role: "member", activity: "idle" },
      ] },
    ],
    leaks: [{ name: "ghost", kind: "orphan_socket", detail: "socket with no live record" }],
  };
  const html = renderToStaticMarkup(createElement(ProcessSection, { ps }));
  expect(html).toContain("demo");
  expect(html).toContain("pid 4321");
  expect(html).toContain("router");
  expect(html).toContain("working");
  expect(html).toContain("ctx 25%");
  expect(html).toContain("orphan socket");
  expect(html).toContain("1 running");
  // structured model is secret-free by construction; assert no obvious credential markers leak through
  expect(html).not.toContain("Bearer");
  expect(html).not.toContain("sha256:");
});

test("ProcessSection degrades gracefully when a running mesh has no agent detail", () => {
  const ps: PsDetail = { running: [{ name: "bare", pid: 7, socketPath: "/run/bare.sock", agents: [] }], leaks: [] };
  const html = renderToStaticMarkup(createElement(ProcessSection, { ps }));
  expect(html).toContain("agent detail unavailable");
});
