import { test, expect } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { FeishuProvisionRegistry } from "./provision";
import { feishuConfigPath } from "./config";

function root() {
  const dir = mkdtempSync(join(tmpdir(), "feishu-provision-"));
  return { dir, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

function writeConfig(root: string, obj: unknown): void {
  mkdirSync(join(root, "channels"), { recursive: true });
  writeFileSync(feishuConfigPath(root), JSON.stringify(obj), "utf8");
}

test("provision returns a link/QR and writes credentials to feishu config on completion", async () => {
  const { dir, cleanup } = root();
  try {
    let reloaded = 0;
    const registry = new FeishuProvisionRegistry({
      root: dir,
      qrCodeDataUrl: async (url) => `data:image/png;base64,${Buffer.from(url).toString("base64")}`,
      registerApp: async (opts: any) => {
        opts.onQRCodeReady({ url: "https://open.feishu.cn/scan?device=1", expireIn: 600 });
        return {
          client_id: "cli_1",
          client_secret: "secret",
          user_info: { open_id: "ou_me", tenant_brand: "feishu" },
        };
      },
      onConfigWritten: () => {
        reloaded++;
      },
    });
    const job = await registry.start({ mesh: "m", chatId: "oc_1", botMentionId: "ou_bot", botName: "MeshBot", requireMention: false, enable: true });
    expect(job.state === "waiting" || job.state === "complete").toBe(true);
    expect(job.verificationUrl).toContain("open.feishu.cn");
    expect(job.qrCodeDataUrl).toContain("data:image/png");

    await waitUntil(() => registry.get(job.id)?.state === "complete");
    const done = registry.get(job.id)!;
    expect(done).toMatchObject({ state: "complete", appId: "cli_1", openId: "ou_me" });
    const cfg = JSON.parse(readFileSync(feishuConfigPath(dir), "utf8"));
    expect(cfg).toMatchObject({
      enabled: true,
      appId: "cli_1",
      appSecret: "secret",
      mesh: "m",
      chatId: "oc_1",
      botMentionId: "ou_bot",
      botName: "MeshBot",
      requireMention: false,
      allowSenders: ["ou_me"],
    });
    expect(reloaded).toBe(1);
  } finally {
    cleanup();
  }
});

test("provision without mesh/chat keeps the channel disabled for later independent enablement", async () => {
  const { dir, cleanup } = root();
  try {
    const registry = new FeishuProvisionRegistry({
      root: dir,
      qrCodeDataUrl: async () => "qr",
      registerApp: async (opts: any) => {
        opts.onQRCodeReady({ url: "https://open.feishu.cn/scan?device=2", expireIn: 600 });
        return { client_id: "cli_2", client_secret: "secret_2", user_info: { open_id: "ou_me" } };
      },
    });
    const job = await registry.start();
    await waitUntil(() => registry.get(job.id)?.state === "complete");
    const cfg = JSON.parse(readFileSync(feishuConfigPath(dir), "utf8"));
    expect(cfg.enabled).toBe(false);
    expect(cfg.appId).toBe("cli_2");
    expect(cfg.chatId).toBe("");
  } finally {
    cleanup();
  }
});

test("provisioning a different app clears old mesh chat bindings", async () => {
  const { dir, cleanup } = root();
  try {
    writeConfig(dir, {
      enabled: true,
      appId: "cli_old",
      appSecret: "old_secret",
      mesh: "m",
      chatId: "oc_old",
      bindings: [{ mesh: "m", chatId: "oc_old" }],
      allowSenders: ["ou_old"],
    });
    const registry = new FeishuProvisionRegistry({
      root: dir,
      qrCodeDataUrl: async () => "qr",
      registerApp: async (opts: any) => {
        opts.onQRCodeReady({ url: "https://open.feishu.cn/scan?device=3", expireIn: 600 });
        return { client_id: "cli_new", client_secret: "new_secret", user_info: { open_id: "ou_new" } };
      },
    });
    const job = await registry.start({ enable: true });
    await waitUntil(() => registry.get(job.id)?.state === "complete");
    const cfg = JSON.parse(readFileSync(feishuConfigPath(dir), "utf8"));
    expect(cfg.appId).toBe("cli_new");
    expect(cfg.appSecret).toBe("new_secret");
    expect(cfg.bindings).toEqual([]);
    expect(cfg.mesh).toBe("");
    expect(cfg.chatId).toBe("");
    expect(cfg.allowSenders).toEqual(["ou_new"]);
  } finally {
    cleanup();
  }
});

async function waitUntil(fn: () => boolean, timeoutMs = 1000): Promise<void> {
  const start = Date.now();
  while (!fn()) {
    if (Date.now() - start > timeoutMs) throw new Error("timeout");
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}
