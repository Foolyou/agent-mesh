import { test, expect } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { FeishuChannelController, feishuMeshChatName, isMeshConfigFile } from "./controller";
import { feishuConfigPath } from "./config";
import type { Channel, MeshGateway } from "./types";
import type { MeshEvent } from "../acp/types";

function root() {
  const dir = mkdtempSync(join(tmpdir(), "feishu-controller-"));
  return { dir, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

function writeConfig(root: string, obj: unknown): void {
  mkdirSync(join(root, "channels"), { recursive: true });
  writeFileSync(feishuConfigPath(root), JSON.stringify(obj), "utf8");
}

const mesh: MeshGateway = {
  on(_l: (name: string, e: MeshEvent) => void) {
    return () => {};
  },
  async promptRouter() {},
  async startMesh() {},
  async stopMesh() {},
  async newAllSessions() {},
  routerOf() {
    return "router";
  },
  listMeshes() {
    return [{ name: "m", status: "running" }];
  },
};

test("reload starts, restarts, and stops the configured channel", async () => {
  const { dir, cleanup } = root();
  try {
    const calls: string[] = [];
    let n = 0;
    const build = (): Channel => {
      const id = ++n;
      return {
        start: () => {
          calls.push(`start-${id}`);
        },
        stop: () => {
          calls.push(`stop-${id}`);
        },
      };
    };
    const ctl = new FeishuChannelController(mesh, { root: dir, watch: false, buildChannel: build });

    await ctl.reload();
    expect(ctl.status().state).toBe("disabled");
    expect(calls).toEqual([]);

    writeConfig(dir, { enabled: true, appId: "cli_1", appSecret: "secret", mesh: "m", chatId: "oc_1" });
    await ctl.reload();
    expect(ctl.status()).toMatchObject({ state: "running", mesh: "m", chatId: "oc_1", appId: "cli_1" });
    expect(calls).toEqual(["start-1"]);

    writeConfig(dir, { enabled: true, appId: "cli_1", appSecret: "secret", mesh: "m", chatId: "oc_2" });
    await ctl.reload();
    expect(ctl.status()).toMatchObject({ state: "running", chatId: "oc_2" });
    expect(calls).toEqual(["start-1", "stop-1", "start-2"]);

    writeConfig(dir, { enabled: false, appId: "cli_1", appSecret: "secret", mesh: "m", chatId: "oc_2" });
    await ctl.reload();
    expect(ctl.status().state).toBe("disabled");
    expect(calls).toEqual(["start-1", "stop-1", "start-2", "stop-2"]);
  } finally {
    cleanup();
  }
});

test("start creates a channels directory so feishu can be enabled later", async () => {
  const { dir, cleanup } = root();
  try {
    const ctl = new FeishuChannelController(mesh, { root: dir, watch: true, buildChannel: () => undefined });
    await ctl.start();
    expect(ctl.status().state).toBe("disabled");
    await ctl.stop();
  } finally {
    cleanup();
  }
});

test("ensureMeshChat creates a missing group and writes a binding", async () => {
  const { dir, cleanup } = root();
  try {
    const created: string[] = [];
    writeConfig(dir, { enabled: true, appId: "cli_1", appSecret: "secret", allowSenders: ["ou_me"], requireMention: false });
    const ctl = new FeishuChannelController(mesh, {
      root: dir,
      watch: false,
      buildChannel: () => ({ start() {}, stop() {} }),
      createChat: async (_cfg, meshName) => {
        created.push(meshName);
        return { chatId: `oc_${meshName}`, name: `${meshName} group` };
      },
    });

    const first = await ctl.ensureMeshChat("m");
    const second = await ctl.ensureMeshChat("m");
    expect(first).toMatchObject({ mesh: "m", chatId: "oc_m", created: true, ok: true });
    expect(second).toMatchObject({ mesh: "m", chatId: "oc_m", created: false, ok: true });
    expect(created).toEqual(["m"]);
    const cfg = JSON.parse(readFileSync(feishuConfigPath(dir), "utf8"));
    expect(cfg.bindings).toEqual([{ mesh: "m", chatId: "oc_m", name: "m group", source: "auto", createdAt: expect.any(String) }]);
  } finally {
    cleanup();
  }
});

test("start auto-creates missing mesh groups for an already-bound bot", async () => {
  const { dir, cleanup } = root();
  try {
    writeConfig(dir, { enabled: true, appId: "cli_1", appSecret: "secret", allowSenders: ["ou_me"] });
    const ctl = new FeishuChannelController(mesh, {
      root: dir,
      watch: false,
      buildChannel: () => ({ start() {}, stop() {} }),
      createChat: async (_cfg, meshName) => ({ chatId: `oc_${meshName}` }),
    });
    await ctl.start();
    const cfg = JSON.parse(readFileSync(feishuConfigPath(dir), "utf8"));
    expect(cfg.bindings).toMatchObject([{ mesh: "m", chatId: "oc_m", source: "auto" }]);
  } finally {
    cleanup();
  }
});

// ── feishuMeshChatName: "<mesh>@<hostname>" ─────────────────────────────────────

test("feishuMeshChatName renders <mesh>@<hostname>", () => {
  expect(feishuMeshChatName("ops", "my-host")).toBe("ops@my-host");
});

test("feishuMeshChatName falls back to 'mesh' when the mesh name is blank", () => {
  expect(feishuMeshChatName("   ", "my-host")).toBe("mesh@my-host");
});

test("feishuMeshChatName falls back to 'host' when the hostname is empty/blank", () => {
  expect(feishuMeshChatName("ops", "")).toBe("ops@host");
  expect(feishuMeshChatName("ops", "   ")).toBe("ops@host");
});

test("feishuMeshChatName caps total length, reserving budget for the host suffix", () => {
  const name = feishuMeshChatName("m".repeat(100), "h".repeat(100));
  expect(name.length).toBeLessThanOrEqual(60);
  expect(name.endsWith(`@${"h".repeat(30)}`)).toBe(true); // host capped at 30
  expect(name.startsWith("m".repeat(29))).toBe(true); // mesh gets the remaining budget (60 - 31)
  expect(name).toBe(`${"m".repeat(29)}@${"h".repeat(30)}`);
});

test("feishuMeshChatName carries no 联调 / PoC / Mesh wording", () => {
  const name = feishuMeshChatName("ops", "my-host");
  expect(name).not.toContain("联调");
  expect(name).not.toContain("PoC");
  expect(name).not.toContain("Mesh");
  expect(name).not.toContain("·");
});

// ── meshes/ directory watcher (feishu-mesh-watch-sync) ──────────────────────────

/** A controllable debounce timer: stores the latest scheduled fn (cancel-then-set models the debounce),
 *  fires only on flush(). hasPending() reports whether a sync is scheduled. */
function controllableTimer() {
  let pending: (() => void) | null = null;
  return {
    setTimer: (fn: () => void, _ms: number) => { pending = fn; return () => { if (pending === fn) pending = null; }; },
    flush: () => { const f = pending; pending = null; f?.(); },
    hasPending: () => pending !== null,
  };
}

/** A mesh gateway whose listMeshes() reflects a mutable name list (simulating defineMesh/in-memory) and
 *  counts how many times it is read (to assert sync coalescing). */
function dynamicMesh(names: string[]) {
  let listCalls = 0;
  const gw: MeshGateway = { ...mesh, listMeshes() { listCalls++; return names.map((name) => ({ name, status: "running" as const })); } };
  return { gw, calls: () => listCalls };
}

async function waitFor(cond: () => boolean, ms = 2500): Promise<boolean> {
  const end = Date.now() + ms;
  while (Date.now() < end) { if (cond()) return true; await new Promise((r) => setTimeout(r, 10)); }
  return cond();
}
const writeMesh = (dir: string, file: string, body: unknown = { name: file.replace(/\.json$/, ""), agents: [] }) => {
  mkdirSync(join(dir, "meshes"), { recursive: true });
  writeFileSync(join(dir, "meshes", file), JSON.stringify(body), "utf8");
};

test("isMeshConfigFile accepts <mesh>.json and rejects sessions/temp/hidden/non-json/dir", () => {
  expect(isMeshConfigFile("ops.json")).toBe(true);
  expect(isMeshConfigFile("ops.sessions.json")).toBe(false); // session state
  expect(isMeshConfigFile("ops.json.tmp")).toBe(false);       // atomic-write intermediate
  expect(isMeshConfigFile("ops.json~")).toBe(false);          // editor backup
  expect(isMeshConfigFile(".ops.json")).toBe(false);          // hidden / editor temp
  expect(isMeshConfigFile("ops.txt")).toBe(false);
  expect(isMeshConfigFile("")).toBe(false);                   // dir / no filename
});

test("meshes watcher: writing meshes/<name>.json after start triggers sync and creates the binding (no restart)", async () => {
  const { dir, cleanup } = root();
  try {
    writeConfig(dir, { enabled: true, appId: "cli_1", appSecret: "secret", allowSenders: ["ou_me"] });
    const created: string[] = [];
    const names = ["m"];
    const { gw } = dynamicMesh(names);
    const timer = controllableTimer();
    const ctl = new FeishuChannelController(gw, {
      root: dir, watch: true,
      buildChannel: () => ({ start() {}, stop() {} }),
      createChat: async (_c, name) => { created.push(name); return { chatId: `oc_${name}` }; },
      setTimer: timer.setTimer,
    });
    await ctl.start();
    expect(created).toEqual(["m"]); // start() ensured the already-known mesh

    names.push("m2"); // a new mesh appears (create_mesh/defineMesh: in-memory + file)
    writeMesh(dir, "m2.json");
    expect(await waitFor(timer.hasPending)).toBe(true); // fs event → debounced sync scheduled
    timer.flush();
    expect(await waitFor(() => created.includes("m2"))).toBe(true); // binding created without restart
    await ctl.stop();
  } finally { cleanup(); }
});

test("meshes watcher: an existing binding is not re-created on a later file change (idempotent)", async () => {
  const { dir, cleanup } = root();
  try {
    writeConfig(dir, { enabled: true, appId: "cli_1", appSecret: "secret", allowSenders: ["ou_me"] });
    const created: string[] = [];
    const names = ["m"];
    const { gw } = dynamicMesh(names);
    const timer = controllableTimer();
    const ctl = new FeishuChannelController(gw, {
      root: dir, watch: true,
      buildChannel: () => ({ start() {}, stop() {} }),
      createChat: async (_c, name) => { created.push(name); return { chatId: `oc_${name}` }; },
      setTimer: timer.setTimer,
    });
    await ctl.start();
    expect(created).toEqual(["m"]); // "m" bound

    writeMesh(dir, "m.json"); // a modify of the already-bound mesh
    expect(await waitFor(timer.hasPending)).toBe(true);
    timer.flush();
    await waitFor(() => false, 150); // let the sync run
    expect(created).toEqual(["m"]); // NO duplicate createChat for the existing binding
    await ctl.stop();
  } finally { cleanup(); }
});

test("meshes watcher: ignored names (.sessions.json, temp) do not schedule a sync", async () => {
  const { dir, cleanup } = root();
  try {
    writeConfig(dir, { enabled: true, appId: "cli_1", appSecret: "secret", allowSenders: ["ou_me"] });
    const { gw } = dynamicMesh(["m"]);
    const timer = controllableTimer();
    const ctl = new FeishuChannelController(gw, {
      root: dir, watch: true,
      buildChannel: () => ({ start() {}, stop() {} }),
      createChat: async (_c, name) => ({ chatId: `oc_${name}` }),
      setTimer: timer.setTimer,
    });
    await ctl.start();
    writeMesh(dir, "m.sessions.json");
    writeMesh(dir, "m.json.tmp");
    await waitFor(() => false, 250); // give fs.watch time to deliver the (ignored) events
    expect(timer.hasPending()).toBe(false); // neither scheduled a sync
    await ctl.stop();
  } finally { cleanup(); }
});

test("meshes watcher: rapid multiple mesh-file writes coalesce into a SINGLE sync", async () => {
  const { dir, cleanup } = root();
  try {
    writeConfig(dir, { enabled: true, appId: "cli_1", appSecret: "secret", allowSenders: ["ou_me"] });
    const names = ["m"];
    const { gw, calls } = dynamicMesh(names);
    const timer = controllableTimer();
    const ctl = new FeishuChannelController(gw, {
      root: dir, watch: true,
      buildChannel: () => ({ start() {}, stop() {} }),
      createChat: async (_c, name) => ({ chatId: `oc_${name}` }),
      setTimer: timer.setTimer,
    });
    await ctl.start();
    writeMesh(dir, "a.json"); writeMesh(dir, "b.json"); writeMesh(dir, "c.json"); // rapid burst
    expect(await waitFor(timer.hasPending)).toBe(true);
    const base = calls();
    timer.flush(); // the debounce collapsed the burst into one scheduled fn
    await waitFor(() => false, 100);
    expect(calls() - base).toBe(1); // exactly one syncMeshChats (listMeshes read once)
    await ctl.stop();
  } finally { cleanup(); }
});

test("meshes watcher: a createChat failure is logged and contained; the watcher stays usable", async () => {
  const { dir, cleanup } = root();
  try {
    writeConfig(dir, { enabled: true, appId: "cli_1", appSecret: "secret", allowSenders: ["ou_me"] });
    const logs: string[] = [];
    const created: string[] = [];
    let fail = true;
    const names = ["m"];
    const { gw } = dynamicMesh(names);
    const timer = controllableTimer();
    const ctl = new FeishuChannelController(gw, {
      root: dir, watch: true, log: (m) => logs.push(m),
      buildChannel: () => ({ start() {}, stop() {} }),
      createChat: async (_c, name) => { if (fail) throw new Error("boom"); created.push(name); return { chatId: `oc_${name}` }; },
      setTimer: timer.setTimer,
    });
    await ctl.start(); // "m" fails to create (logged), does not throw
    names.push("m2");
    writeMesh(dir, "m2.json");
    expect(await waitFor(timer.hasPending)).toBe(true);
    timer.flush();
    expect(await waitFor(() => logs.some((l) => l.includes("failed to ensure mesh chat")))).toBe(true);

    // watcher still usable: a later success creates the chat
    fail = false;
    writeMesh(dir, "m2.json");
    expect(await waitFor(timer.hasPending)).toBe(true);
    timer.flush();
    expect(await waitFor(() => created.includes("m2"))).toBe(true);
    await ctl.stop();
  } finally { cleanup(); }
});

test("meshes watcher: stop() closes the watcher — a later mesh-file write does not schedule a sync", async () => {
  const { dir, cleanup } = root();
  try {
    writeConfig(dir, { enabled: true, appId: "cli_1", appSecret: "secret", allowSenders: ["ou_me"] });
    const { gw } = dynamicMesh(["m"]);
    const timer = controllableTimer();
    const ctl = new FeishuChannelController(gw, {
      root: dir, watch: true,
      buildChannel: () => ({ start() {}, stop() {} }),
      createChat: async (_c, name) => ({ chatId: `oc_${name}` }),
      setTimer: timer.setTimer,
    });
    await ctl.start();
    await ctl.stop();
    writeMesh(dir, "after-stop.json");
    await waitFor(() => false, 250);
    expect(timer.hasPending()).toBe(false); // closed watcher → no schedule
  } finally { cleanup(); }
});

// ── Bug 2: new chats invite device-auth approved users, not legacy cfg.allowSenders ──

function writeAuthRegistry(root: string, entries: { channelKey: string; openId: string; status: string }[]): void {
  mkdirSync(join(root, "auth"), { recursive: true });
  const allow: Record<string, unknown> = {};
  entries.forEach((e, i) => { allow[`k${i}`] = { ...e, approvedAt: new Date().toISOString() }; });
  writeFileSync(join(root, "auth", "feishu.json"), JSON.stringify({ version: 1, allow, pending: {} }), "utf8");
}

test("ensureMeshChat seeds a new chat with device-auth approved openIds (not cfg.allowSenders)", async () => {
  const { dir, cleanup } = root();
  try {
    // legacy allowSenders is present but MUST be ignored; the registry holds the real authorized users
    writeConfig(dir, { enabled: true, appId: "cli_1", appSecret: "secret", allowSenders: ["ou_LEGACY"], requireMention: false });
    writeAuthRegistry(dir, [
      { channelKey: "feishu:cli_1", openId: "ou_1", status: "approved" },
      { channelKey: "feishu:cli_1", openId: "ou_2", status: "approved" },
      { channelKey: "feishu:cli_1", openId: "ou_r", status: "revoked" },        // excluded
      { channelKey: "feishu:cli_other", openId: "ou_x", status: "approved" },    // other app excluded
    ]);
    let seenUserIds: string[] | undefined;
    const ctl = new FeishuChannelController(mesh, {
      root: dir, watch: false,
      buildChannel: () => ({ start() {}, stop() {} }),
      createChat: async (_cfg, name, userIds) => { seenUserIds = userIds; return { chatId: `oc_${name}` }; },
    });
    const res = await ctl.ensureMeshChat("m");
    expect(res).toMatchObject({ mesh: "m", chatId: "oc_m", created: true, ok: true });
    expect(seenUserIds?.sort()).toEqual(["ou_1", "ou_2"]); // approved registry users; never ou_LEGACY
  } finally { cleanup(); }
});

test("ensureMeshChat with no approved users creates a bot-only chat (empty user list, no error)", async () => {
  const { dir, cleanup } = root();
  try {
    writeConfig(dir, { enabled: true, appId: "cli_1", appSecret: "secret", allowSenders: ["ou_LEGACY"], requireMention: false });
    // no auth/feishu.json → empty registry
    let seenUserIds: string[] | undefined;
    const ctl = new FeishuChannelController(mesh, {
      root: dir, watch: false,
      buildChannel: () => ({ start() {}, stop() {} }),
      createChat: async (_cfg, name, userIds) => { seenUserIds = userIds; return { chatId: `oc_${name}` }; },
    });
    const res = await ctl.ensureMeshChat("m");
    expect(res).toMatchObject({ mesh: "m", created: true, ok: true });
    expect(seenUserIds).toEqual([]); // bot-only, no legacy allowSenders leak
  } finally { cleanup(); }
});

test("ensureMeshChat skips createChat for an already-bound mesh (idempotent; no invite/recreate)", async () => {
  const { dir, cleanup } = root();
  try {
    writeConfig(dir, { enabled: true, appId: "cli_1", appSecret: "secret", allowSenders: [], bindings: [{ mesh: "m", chatId: "oc_existing", name: "m", source: "auto", createdAt: new Date().toISOString() }] });
    writeAuthRegistry(dir, [{ channelKey: "feishu:cli_1", openId: "ou_1", status: "approved" }]);
    let createCalls = 0;
    const ctl = new FeishuChannelController(mesh, {
      root: dir, watch: false,
      buildChannel: () => ({ start() {}, stop() {} }),
      createChat: async (_cfg, name) => { createCalls++; return { chatId: `oc_${name}` }; },
    });
    const res = await ctl.ensureMeshChat("m");
    expect(res).toMatchObject({ mesh: "m", chatId: "oc_existing", created: false, ok: true });
    expect(createCalls).toBe(0); // existing binding → no createChat, no invite
  } finally { cleanup(); }
});
