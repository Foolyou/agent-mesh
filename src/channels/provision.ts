// src/channels/provision.ts
//
// One-click Feishu bot creation backed by the official SDK registerApp flow. The HTTP API starts
// a background device-auth job, returns the verification link + QR code once ready, and writes the
// returned credentials into channels/feishu.json when the user completes the scan/authorization.

import * as lark from "@larksuiteoapi/node-sdk";
import QRCode from "qrcode";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { feishuConfigPath } from "./config";
import type { FeishuProvisionJobPublic, FeishuProvisionStartRequest } from "./types";

export interface FeishuProvisionRegistryOptions {
  root: string;
  log?: (msg: string) => void;
  onConfigWritten?: () => unknown;
  registerApp?: typeof lark.registerApp;
  qrCodeDataUrl?: (url: string) => Promise<string>;
}

interface Job extends FeishuProvisionJobPublic {
  controller: AbortController;
  ready: Promise<void>;
  resolveReady: () => void;
}

const DEFAULT_SCOPES = [
  "im:message",
  "im:message:send_as_bot",
  "im:message.p2p_msg",
  "im:message.group_at_msg",
  "im:message.group_msg",
  "im:chat",
  "im:chat:member",
];

export class FeishuProvisionRegistry {
  private readonly root: string;
  private readonly log: (msg: string) => void;
  private readonly onConfigWritten?: () => unknown;
  private readonly registerApp: typeof lark.registerApp;
  private readonly qrCodeDataUrl: (url: string) => Promise<string>;
  private seq = 0;
  private readonly jobs = new Map<string, Job>();

  constructor(opts: FeishuProvisionRegistryOptions) {
    this.root = opts.root;
    this.log = opts.log ?? (() => {});
    this.onConfigWritten = opts.onConfigWritten;
    this.registerApp = opts.registerApp ?? lark.registerApp;
    this.qrCodeDataUrl = opts.qrCodeDataUrl ?? ((url) => QRCode.toDataURL(url, { margin: 1, scale: 6 }));
  }

  async start(input: FeishuProvisionStartRequest = {}): Promise<FeishuProvisionJobPublic> {
    const id = `feishu-${Date.now().toString(36)}-${++this.seq}`;
    let resolveReady!: () => void;
    const ready = new Promise<void>((resolve) => {
      resolveReady = resolve;
    });
    const job: Job = {
      id,
      state: "starting",
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      controller: new AbortController(),
      ready,
      resolveReady,
      configPath: feishuConfigPath(this.root),
    };
    this.jobs.set(id, job);
    void this.run(job, input);
    await Promise.race([ready, sleep(8000)]);
    return publicJob(job);
  }

  get(id: string): FeishuProvisionJobPublic | undefined {
    const job = this.jobs.get(id);
    return job ? publicJob(job) : undefined;
  }

  cancel(id: string): FeishuProvisionJobPublic | undefined {
    const job = this.jobs.get(id);
    if (!job) return undefined;
    if (job.state === "complete" || job.state === "error" || job.state === "cancelled") return publicJob(job);
    job.controller.abort();
    update(job, { state: "cancelled", error: "cancelled" });
    job.resolveReady();
    return publicJob(job);
  }

  private async run(job: Job, input: FeishuProvisionStartRequest): Promise<void> {
    try {
      const result = await this.registerApp({
        source: "agent-mesh/openclaw-hermes",
        createOnly: input.createOnly ?? true,
        appId: input.appId,
        appPreset: {
          name: input.appName || "Agent Mesh Bot",
          desc: input.appDescription || "Agent Mesh Feishu gateway bot",
        },
        addons: {
          scopes: { tenant: DEFAULT_SCOPES },
          events: { items: { tenant: ["im.message.receive_v1"] } },
        },
        signal: job.controller.signal,
        onQRCodeReady: (info) => {
          void this.qrCodeDataUrl(info.url)
            .then((qrCodeDataUrl) => update(job, { state: "waiting", verificationUrl: info.url, qrCodeDataUrl, expireIn: info.expireIn }))
            .catch((e) => update(job, { state: "waiting", verificationUrl: info.url, expireIn: info.expireIn, error: `QR generation failed: ${String(e)}` }))
            .finally(() => job.resolveReady());
        },
        onStatusChange: (info) => {
          this.log(`feishu provision ${job.id}: ${info.status}${info.interval ? ` interval=${info.interval}` : ""}`);
        },
      });
      await this.writeConfig(input, {
        appId: result.client_id,
        appSecret: result.client_secret,
        openId: result.user_info?.open_id,
      });
      update(job, {
        state: "complete",
        appId: result.client_id,
        tenantBrand: result.user_info?.tenant_brand,
        openId: result.user_info?.open_id,
        error: undefined,
      });
      await this.onConfigWritten?.();
    } catch (e: any) {
      const code = typeof e?.code === "string" ? e.code : undefined;
      update(job, { state: code === "abort" ? "cancelled" : "error", error: String(e?.description ?? e?.message ?? e) });
      job.resolveReady();
    }
  }

  private async writeConfig(input: FeishuProvisionStartRequest, app: { appId: string; appSecret: string; openId?: string }): Promise<void> {
    const path = feishuConfigPath(this.root);
    await mkdir(dirname(path), { recursive: true });
    const existing = await readJson(path);
    const existingSameApp = sameApp(existing, app.appId);
    const allowSenders = input.allowSenders?.length
      ? input.allowSenders
      : existingSameApp && Array.isArray(existing.allowSenders) && existing.allowSenders.length
        ? existing.allowSenders
        : app.openId
          ? [app.openId]
          : [];
    const existingBindings = existingSameApp ? bindingsOf(existing) : [];
    const chatId = input.chatId ?? (existingSameApp ? str(existing.chatId) : "");
    const mesh = input.mesh ?? (existingSameApp ? str(existing.mesh) : "");
    const bindings = upsertBinding(existingBindings, {
      mesh,
      chatId,
      botMentionId: input.botMentionId ?? str(existing.botMentionId),
      botName: input.botName ?? str(existing.botName),
      requireMention: input.requireMention ?? (typeof existing.requireMention === "boolean" ? existing.requireMention : true),
    });
    const first = bindings[0];
    const canEnable = input.enable === true || existing.enabled === true;
    const next = {
      ...existing,
      enabled: canEnable,
      appId: app.appId,
      appSecret: app.appSecret,
      domain: existing.domain || "feishu",
      mesh: first?.mesh ?? "",
      chatId: first?.chatId ?? "",
      botMentionId: input.botMentionId ?? str(existing.botMentionId),
      botName: input.botName ?? str(existing.botName),
      requireMention: input.requireMention ?? (typeof existing.requireMention === "boolean" ? existing.requireMention : true),
      allowSenders,
      outbound: existing.outbound && typeof existing.outbound === "object" ? existing.outbound : { minIntervalMs: 500 },
      bindings,
    };
    await writeFile(path, `${JSON.stringify(next, null, 2)}\n`, "utf8");
  }
}

async function readJson(path: string): Promise<Record<string, any>> {
  try {
    const raw = await readFile(path, "utf8");
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : {};
  } catch {
    return {};
  }
}

function publicJob(job: Job): FeishuProvisionJobPublic {
  const { controller: _controller, ready: _ready, resolveReady: _resolveReady, ...pub } = job;
  return { ...pub };
}

function update(job: Job, patch: Partial<FeishuProvisionJobPublic>): void {
  Object.assign(job, patch, { updatedAt: new Date().toISOString() });
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function str(v: unknown): string {
  return typeof v === "string" ? v : "";
}

function sameApp(existing: Record<string, any>, appId: string): boolean {
  const current = str(existing.appId) || str(existing.app_id);
  return !!current && current === appId;
}

function bindingsOf(existing: Record<string, any>): any[] {
  const out: any[] = [];
  const add = (binding: any, fallbackMesh?: string) => {
    const mesh = str(binding?.mesh) || fallbackMesh || "";
    const chatId = str(binding?.chatId) || str(binding?.chat_id);
    if (!mesh || !chatId) return;
    if (out.some((b) => b.mesh === mesh || b.chatId === chatId)) return;
    out.push({ ...binding, mesh, chatId });
  };
  if (Array.isArray(existing.bindings)) {
    for (const binding of existing.bindings) add(binding);
  }
  const chats = existing.chats ?? existing.meshChats;
  if (chats && typeof chats === "object" && !Array.isArray(chats)) {
    for (const [mesh, binding] of Object.entries(chats)) {
      if (typeof binding === "string") add({ chatId: binding }, mesh);
      else add(binding, mesh);
    }
  }
  add(existing);
  return out;
}

function upsertBinding(bindings: any[], binding: { mesh: string; chatId: string; botMentionId?: string; botName?: string; requireMention?: boolean }): any[] {
  if (!binding.mesh || !binding.chatId) return bindings;
  const item = {
    mesh: binding.mesh,
    chatId: binding.chatId,
    ...(binding.botMentionId ? { botMentionId: binding.botMentionId } : {}),
    ...(binding.botName ? { botName: binding.botName } : {}),
    ...(binding.requireMention !== undefined ? { requireMention: binding.requireMention } : {}),
    source: "manual",
  };
  return [...bindings.filter((b) => b.mesh !== binding.mesh && b.chatId !== binding.chatId), item];
}
