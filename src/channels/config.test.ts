import { test, expect } from "bun:test";
import { mkdtempSync, writeFileSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { normalizeFeishuConfig, loadFeishuConfig, feishuConfigPath } from "./config";

function withRoot(write?: (root: string) => void): { root: string; cleanup: () => void } {
  const root = mkdtempSync(join(tmpdir(), "feishu-cfg-"));
  write?.(root);
  return { root, cleanup: () => rmSync(root, { recursive: true, force: true }) };
}

function writeConfig(root: string, obj: unknown): void {
  mkdirSync(join(root, "channels"), { recursive: true });
  writeFileSync(feishuConfigPath(root), JSON.stringify(obj), "utf8");
}

test("normalizeFeishuConfig fills defaults and carries enabled through", () => {
  const cfg = normalizeFeishuConfig({ enabled: true, mesh: "feishu-poc", chatId: "oc_1" });
  expect(cfg).toBeTruthy();
  expect(cfg!.mesh).toBe("feishu-poc");
  expect(cfg!.chatId).toBe("oc_1");
  expect(cfg!.botName).toBe("");
  expect(cfg!.allowSenders).toEqual([]);
  expect(cfg!.outbound.minIntervalMs).toBe(500);
  expect(cfg!.enabled).toBe(true);
});

test("normalizeFeishuConfig rejects missing required fields", () => {
  expect(normalizeFeishuConfig({ enabled: true, mesh: "m" })).toBeUndefined(); // no chatId
  expect(normalizeFeishuConfig({ enabled: true, chatId: "oc_1" })).toBeUndefined(); // no mesh
  expect(normalizeFeishuConfig({})).toBeUndefined();
  expect(normalizeFeishuConfig(null)).toBeUndefined();
  expect(normalizeFeishuConfig("nope")).toBeUndefined();
});

test("normalizeFeishuConfig filters non-string allowSenders and trims strings", () => {
  const cfg = normalizeFeishuConfig({
    enabled: false,
    mesh: " feishu-poc ",
    chatId: " oc_1 ",
    botName: " MeshBot ",
    allowSenders: ["ou_a", 42, "", "ou_b"],
    outbound: { minIntervalMs: 0 },
  });
  expect(cfg!.mesh).toBe("feishu-poc");
  expect(cfg!.chatId).toBe("oc_1");
  expect(cfg!.botName).toBe("MeshBot");
  expect(cfg!.allowSenders).toEqual(["ou_a", "ou_b"]);
  expect(cfg!.outbound.minIntervalMs).toBe(0);
  expect(cfg!.enabled).toBe(false);
});

test("normalizeFeishuConfig falls back minIntervalMs for invalid/negative values", () => {
  expect(normalizeFeishuConfig({ enabled: true, mesh: "m", chatId: "c", outbound: { minIntervalMs: -5 } })!.outbound.minIntervalMs).toBe(500);
  expect(normalizeFeishuConfig({ enabled: true, mesh: "m", chatId: "c", outbound: { minIntervalMs: "x" } })!.outbound.minIntervalMs).toBe(500);
});

test("loadFeishuConfig returns undefined when the file is absent", () => {
  const { root, cleanup } = withRoot();
  try {
    const logs: string[] = [];
    expect(loadFeishuConfig(root, (m) => logs.push(m))).toBeUndefined();
    expect(logs.some((l) => l.includes("no config"))).toBe(true);
  } finally {
    cleanup();
  }
});

test("loadFeishuConfig returns undefined on invalid JSON", () => {
  const { root, cleanup } = withRoot((r) => {
    mkdirSync(join(r, "channels"), { recursive: true });
    writeFileSync(feishuConfigPath(r), "{not json", "utf8");
  });
  try {
    const logs: string[] = [];
    expect(loadFeishuConfig(root, (m) => logs.push(m))).toBeUndefined();
    expect(logs.some((l) => l.includes("invalid JSON"))).toBe(true);
  } finally {
    cleanup();
  }
});

test("loadFeishuConfig returns undefined when enabled=false", () => {
  const { root, cleanup } = withRoot((r) => writeConfig(r, { enabled: false, mesh: "m", chatId: "oc_1" }));
  try {
    const logs: string[] = [];
    expect(loadFeishuConfig(root, (m) => logs.push(m))).toBeUndefined();
    expect(logs.some((l) => l.includes("enabled=false"))).toBe(true);
  } finally {
    cleanup();
  }
});

test("loadFeishuConfig returns the config when present and enabled", () => {
  const { root, cleanup } = withRoot((r) =>
    writeConfig(r, { enabled: true, mesh: "feishu-poc", chatId: "oc_1", botName: "MeshBot", allowSenders: ["ou_a"] }),
  );
  try {
    const cfg = loadFeishuConfig(root);
    expect(cfg).toBeTruthy();
    expect(cfg!.mesh).toBe("feishu-poc");
    expect(cfg!.allowSenders).toEqual(["ou_a"]);
  } finally {
    cleanup();
  }
});
