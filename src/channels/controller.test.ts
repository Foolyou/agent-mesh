import { test, expect } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { FeishuChannelController, feishuMeshChatName } from "./controller";
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
