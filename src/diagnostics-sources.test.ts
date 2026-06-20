import { expect, test } from "bun:test";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { meshConfigChecks, authReadiness, webPsSources, type LiveSnapshot } from "./diagnostics-sources";
import type { MeshHostRecord } from "./mesh-registry";
import { updateDevices } from "./auth-store";
import { hashToken } from "./auth-codes";

async function tmpRoot(): Promise<string> {
  return mkdtemp(join(tmpdir(), "diag-src-"));
}

test("meshConfigChecks validates each meshes/*.json in isolation (one bad file doesn't hide the rest)", async () => {
  const root = await tmpRoot();
  try {
    const dir = join(root, "meshes");
    await mkdir(dir, { recursive: true });
    // a valid mesh
    await writeFile(join(dir, "good.json"), JSON.stringify({ name: "good", agents: [{ id: "r", harness: "codex", project: ".", role: "router" }], edges: [] }), "utf8");
    // invalid: duplicate agent id (validateMeshConfig should reject)
    await writeFile(join(dir, "dup.json"), JSON.stringify({ name: "dup", agents: [{ id: "r", harness: "codex", project: ".", role: "router" }, { id: "r", harness: "codex", project: ".", role: "member" }], edges: [] }), "utf8");
    // invalid JSON entirely
    await writeFile(join(dir, "broken.json"), "{ not json", "utf8");

    const checks = await meshConfigChecks(root);
    const m = Object.fromEntries(checks.map((c) => [c.name, c]));
    expect(m.good.ok).toBe(true);
    expect(m.dup.ok).toBe(false);
    expect(m.dup.error).toBeTruthy();
    expect(m.broken.ok).toBe(false); // parse error isolated, not thrown
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("meshConfigChecks: no meshes dir => []", async () => {
  const root = await tmpRoot();
  try {
    expect(await meshConfigChecks(root)).toEqual([]);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

const REC = (name: string): MeshHostRecord => ({ name, pid: 123, socketPath: `/run/${name}.sock`, startedAt: "2026-06-20T00:00:00.000Z" } as MeshHostRecord);

test("webPsSources: enriches a running mesh from the live snapshot (activity + normalized context %)", async () => {
  const snap: LiveSnapshot = {
    meshes: [{ name: "demo", agents: [
      { id: "router", harness: "claude", role: "router", status: "ready", activity: "working" },
      { id: "m1", harness: "codex", role: "member", activity: "idle" },
    ] }],
    perMesh: { demo: { usage: { router: { used: 50, size: 200 }, m1: { used: 0, size: 0 } } } },
  };
  const deps = webPsSources("/root", snap);
  const agents = await deps.agentsFor!(REC("demo"));
  const router = agents.find((a) => a.id === "router")!;
  expect(router.activity).toBe("working");
  expect(router.harness).toBe("claude");
  expect(router.contextPercent).toBe(25); // 50/200 → 25%, normalized 0–100
  expect(router.contextUsed).toBe(50);
  const m1 = agents.find((a) => a.id === "m1")!;
  expect(m1.activity).toBe("idle");
  expect(m1.contextPercent).toBeUndefined(); // size 0 → no context, never NaN/Infinity
});

test("webPsSources: a running mesh absent from the live snapshot falls back to static config detail", async () => {
  const root = await tmpRoot();
  try {
    const dir = join(root, "meshes");
    await mkdir(dir, { recursive: true });
    await writeFile(join(dir, "demo.json"), JSON.stringify({ name: "demo", agents: [{ id: "r", harness: "codex", project: ".", role: "router" }], edges: [] }), "utf8");
    // snapshot has NO "demo" mesh → must read the static config, marking activity "unknown"
    const deps = webPsSources(root, { meshes: [], perMesh: {} });
    const agents = await deps.agentsFor!(REC("demo"));
    expect(agents).toEqual([{ id: "r", harness: "codex", role: "router", activity: "unknown" }]);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("authReadiness: read-only presence + counts; empty root => all absent, zero counts, no secrets", async () => {
  const root = await tmpRoot();
  try {
    const empty = await authReadiness(root);
    expect(empty.devices).toEqual({ present: false, approved: 0, pending: 0 });
    expect(empty.feishu).toEqual({ present: false, approved: 0, pending: 0 });
    expect(empty.keys.present).toBe(false);

    // seed one approved device via the auth-store API (test setup only)
    await updateDevices(root, (f) => {
      f.devices.dv1 = { status: "approved", tokenHash: hashToken("secret-token"), createdAt: new Date().toISOString() };
      f.pending.CODE = { deviceId: "dv2", tokenHash: hashToken("other"), createdAt: new Date().toISOString(), expiresAt: new Date(Date.now() + 600_000).toISOString() };
    });
    const after = await authReadiness(root);
    expect(after.devices).toEqual({ present: true, approved: 1, pending: 1 });
    // the readiness object carries NO token/hash — only counts/booleans
    expect(JSON.stringify(after)).not.toContain("sha256:");
    expect(JSON.stringify(after)).not.toContain("secret-token");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
