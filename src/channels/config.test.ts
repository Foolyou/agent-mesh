import { test, expect } from "bun:test";
import { mkdtempSync, writeFileSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { normalizeFeishuConfig, loadFeishuConfig, feishuConfigPath, readFeishuConfig } from "./config";

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
  const cfg = normalizeFeishuConfig({ enabled: true, appId: "cli_1", appSecret: "secret", mesh: "feishu-poc", chatId: "oc_1" });
  expect(cfg).toBeTruthy();
  expect(cfg!.appId).toBe("cli_1");
  expect(cfg!.appSecret).toBe("secret");
  expect(cfg!.domain).toBe("feishu");
  expect(cfg!.mesh).toBe("feishu-poc");
  expect(cfg!.chatId).toBe("oc_1");
  expect(cfg!.bindings).toEqual([{ mesh: "feishu-poc", chatId: "oc_1" }]);
  expect(cfg!.botMentionId).toBe("");
  expect(cfg!.botName).toBe("");
  expect(cfg!.requireMention).toBe(true);
  expect(cfg!.allowSenders).toEqual([]);
  expect(cfg!.outbound.minIntervalMs).toBe(500);
  expect(cfg!.websocket).toEqual({});
  expect(cfg!.enabled).toBe(true);
});

test("normalizeFeishuConfig rejects missing required fields", () => {
  expect(normalizeFeishuConfig({ enabled: true, appSecret: "s", mesh: "m", chatId: "oc_1" })).toBeUndefined(); // no appId
  expect(normalizeFeishuConfig({ enabled: true, appId: "cli", mesh: "m", chatId: "oc_1" })).toBeUndefined(); // no appSecret
  expect(normalizeFeishuConfig({})).toBeUndefined();
  expect(normalizeFeishuConfig(null)).toBeUndefined();
  expect(normalizeFeishuConfig("nope")).toBeUndefined();
});

test("normalizeFeishuConfig accepts a bound bot before mesh groups exist", () => {
  const cfg = normalizeFeishuConfig({ enabled: true, appId: "cli", appSecret: "s" });
  expect(cfg).toBeTruthy();
  expect(cfg!.mesh).toBe("");
  expect(cfg!.chatId).toBe("");
  expect(cfg!.bindings).toEqual([]);
});

test("normalizeFeishuConfig filters non-string allowSenders and trims strings", () => {
  const cfg = normalizeFeishuConfig({
    enabled: false,
    app_id: " cli_1 ",
    app_secret: " secret ",
    domain: "lark",
    mesh: " feishu-poc ",
    chatId: " oc_1 ",
    botMentionId: " ou_bot ",
    botName: " MeshBot ",
    requireMention: false,
    allowSenders: ["ou_a", 42, "", "ou_b"],
    outbound: { minIntervalMs: 0 },
    websocket: { handshakeTimeoutMs: 12000, pingTimeout: 30 },
  });
  expect(cfg!.appId).toBe("cli_1");
  expect(cfg!.appSecret).toBe("secret");
  expect(cfg!.domain).toBe("lark");
  expect(cfg!.mesh).toBe("feishu-poc");
  expect(cfg!.chatId).toBe("oc_1");
  expect(cfg!.bindings).toEqual([{ mesh: "feishu-poc", chatId: "oc_1" }]);
  expect(cfg!.botMentionId).toBe("ou_bot");
  expect(cfg!.botName).toBe("MeshBot");
  expect(cfg!.requireMention).toBe(false);
  expect(cfg!.allowSenders).toEqual(["ou_a", "ou_b"]);
  expect(cfg!.outbound.minIntervalMs).toBe(0);
  expect(cfg!.websocket).toEqual({ handshakeTimeoutMs: 12000, pingTimeout: 30 });
  expect(cfg!.enabled).toBe(false);
});

test("normalizeFeishuConfig falls back minIntervalMs for invalid/negative values", () => {
  expect(normalizeFeishuConfig({ enabled: true, appId: "cli", appSecret: "s", mesh: "m", chatId: "c", outbound: { minIntervalMs: -5 } })!.outbound.minIntervalMs).toBe(500);
  expect(normalizeFeishuConfig({ enabled: true, appId: "cli", appSecret: "s", mesh: "m", chatId: "c", outbound: { minIntervalMs: "x" } })!.outbound.minIntervalMs).toBe(500);
});

test("loadFeishuConfig returns undefined when the file is absent", () => {
  const { root, cleanup } = withRoot();
  try {
    const logs: string[] = [];
    expect(loadFeishuConfig(root, (m) => logs.push(m))).toBeUndefined();
    expect(logs.some((l) => l.includes("missing config"))).toBe(true);
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

test("readFeishuConfig reports enabled but incomplete app credentials without throwing", () => {
  const { root, cleanup } = withRoot((r) => writeConfig(r, { enabled: true, appId: "cli_1", appSecret: "secret", mesh: "m" }));
  try {
    const r = readFeishuConfig(root);
    expect(r.enabled).toBe(true);
    expect(r.configured).toBe(true);
    expect(r.config).toBeTruthy();
    expect(r.config!.bindings).toEqual([]);
  } finally {
    cleanup();
  }
});

test("loadFeishuConfig returns the config when present and enabled", () => {
  const { root, cleanup } = withRoot((r) =>
    writeConfig(r, { enabled: true, appId: "cli_1", appSecret: "secret", mesh: "feishu-poc", chatId: "oc_1", botMentionId: "ou_bot", botName: "MeshBot", allowSenders: ["ou_a"] }),
  );
  try {
    const cfg = loadFeishuConfig(root);
    expect(cfg).toBeTruthy();
    expect(cfg!.appId).toBe("cli_1");
    expect(cfg!.mesh).toBe("feishu-poc");
    expect(cfg!.botMentionId).toBe("ou_bot");
    expect(cfg!.allowSenders).toEqual(["ou_a"]);
  } finally {
    cleanup();
  }
});
