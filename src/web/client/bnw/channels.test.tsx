// Step 7.4-A.2b-i — focused SSR tests for the /bnw Channels surface (mockup 07, Option B).
// The stateful BnwChannels fetches via effects (covered by bnw.e2e); here we render the
// presentational pieces against FeishuChannelStatus fixtures + the host-CLI placeholders.
import { test, expect } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { BnwChannels, ChannelStatusCard, ChannelBindingsCard, ProvisionCard, PendingSendersPlaceholder, AuthorizedSendersPlaceholder } from "./channels";
import type { FeishuChannelStatus, FeishuProvisionJobPublic } from "../../types";
import type { Store } from "../store";

const RUNNING: FeishuChannelStatus = {
  state: "running", configPath: "channels/feishu.json", configured: true, enabled: true, appId: "cli_abc", domain: "feishu",
  bindings: [{ mesh: "demo", chatId: "oc_123", name: "demo group", source: "auto", requireMention: true }], updatedAt: "",
};
const noop = () => {};
const NOOP_HANDLERS = { onSync: noop, onBind: noop, onCancel: noop, onEnsure: noop };

test("ChannelStatusCard running: feishu chip + domain + appId + configPath", () => {
  const out = renderToStaticMarkup(<ChannelStatusCard status={RUNNING} />);
  expect(out).toContain("data-channel-status");
  expect(out).toContain("飞书 Feishu");
  expect(out).toContain("running · 1 groups");
  expect(out).toContain("domain: feishu");
  expect(out).toContain("appId cli_abc");
  expect(out).toContain("channels/feishu.json");
  expect(out).toContain("allowSenders 白名单门禁开启");
});

test("ChannelStatusCard not configured (null) + error states", () => {
  expect(renderToStaticMarkup(<ChannelStatusCard status={null} />)).toContain("未配置");
  const err = renderToStaticMarkup(<ChannelStatusCard status={{ ...RUNNING, state: "error", reason: "appSecret missing" }} />);
  expect(err).toContain("config invalid");
  expect(err).toContain("appSecret missing");
});

test("ChannelBindingsCard: binding row + sync/bind + ensure-group control", () => {
  const out = renderToStaticMarkup(<ChannelBindingsCard status={RUNNING} job={null} results={{}} {...NOOP_HANDLERS} />);
  expect(out).toContain("data-bindings");
  expect(out).toContain("绑定 chat → mesh (1)");
  expect(out).toContain('aria-label="sync feishu groups"');
  expect(out).toContain('aria-label="bind chat to mesh"');
  expect(out).toContain("data-binding");
  expect(out).toContain("demo");
  expect(out).toContain("oc_123");
  expect(out).toContain("@mention");
  expect(out).toContain('aria-label="ensure group demo"');
});

test("ChannelBindingsCard empty: 暂无绑定", () => {
  const out = renderToStaticMarkup(<ChannelBindingsCard status={{ ...RUNNING, bindings: [] }} job={null} results={{}} {...NOOP_HANDLERS} />);
  expect(out).toContain("暂无绑定。");
});

test("ProvisionCard: verify link + expiry + cancel; waiting job renders inside bindings", () => {
  const job: FeishuProvisionJobPublic = { id: "j1", state: "waiting", createdAt: "", updatedAt: "", verificationUrl: "https://open.feishu.cn/verify?t=x", expireIn: 272, qrCodeDataUrl: "data:image/png;base64,iVBOR" };
  const card = renderToStaticMarkup(<ProvisionCard job={job} onCancel={noop} />);
  expect(card).toContain("data-provision");
  expect(card).toContain("https://open.feishu.cn/verify?t=x");
  expect(card).toContain("过期：4:32");
  expect(card).toContain('aria-label="cancel provision"');
  // a waiting job surfaces the provision card within the bindings card
  expect(renderToStaticMarkup(<ChannelBindingsCard status={RUNNING} job={job} results={{}} {...NOOP_HANDLERS} />)).toContain("data-provision");
});

test("PendingSenders/AuthorizedSenders placeholders: host-CLI copy, NO fake approve/revoke buttons", () => {
  const pending = renderToStaticMarkup(<PendingSendersPlaceholder />);
  expect(pending).toContain("data-pending-senders");
  expect(pending).toContain("待审批发送者");
  expect(pending).toContain("mesh channels feishu list");
  expect(pending).not.toContain("aria-label=\"approve");
  expect(pending).not.toContain("<button");
  const authd = renderToStaticMarkup(<AuthorizedSendersPlaceholder />);
  expect(authd).toContain("data-authorized-senders");
  expect(authd).toContain("allowSenders");
  expect(authd).not.toContain("aria-label=\"revoke");
  expect(authd).not.toContain("<button");
});

test("BnwChannels shell: PanelFrame + refresh; SSR (no effects) shows loading skeleton", () => {
  const STUB = { getFeishuStatus: async () => RUNNING } as unknown as Store;
  const out = renderToStaticMarkup(<BnwChannels store={STUB} />);
  expect(out).toContain('data-channels="panel"');
  expect(out).toContain("Channels");
  expect(out).toContain('aria-label="refresh channel status"');
  expect(out).toContain("animate-pulse"); // loading skeleton pre-effect
  expect(out).not.toContain("data-channel-status");
});
