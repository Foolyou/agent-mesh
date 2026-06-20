// Unit tests for the channel i18n core (design: docs/design/channel-i18n-prompts.md, C1).
import { test, expect, afterEach } from "bun:test";
import { t, setLocale, getLocale, registerBundle, hasKey, en } from "./index";

afterEach(() => setLocale("en")); // module-global locale — reset between tests

// ── interpolation ──

test("interpolates {name} tokens from params", () => {
  expect(t("feishu.cmd.status", { mesh: "demo", status: "running" })).toBe(
    "[FYI] Mesh status\nmesh: demo\nstatus: running",
  );
});

test("interpolates a numeric {n}-style param", () => {
  registerBundle("num-test", { count: "n={n}" });
  expect(t("count", { n: 5 }, "num-test")).toBe("n=5");
});

test("a missing param interpolates to an empty string (never throws)", () => {
  expect(t("feishu.cmd.status", { mesh: "demo" })).toBe("[FYI] Mesh status\nmesh: demo\nstatus: ");
  expect(t("feishu.cmd.status")).toBe("[FYI] Mesh status\nmesh: \nstatus: ");
});

// ── fallback ──

test("missing key falls back active → en → the literal key", () => {
  registerBundle("partial", { "only.here": "x" });
  setLocale("partial");
  // present in en but not in `partial` → en value
  expect(t("feishu.cmd.startDone", { mesh: "m" })).toBe("[DONE] Mesh started\nmesh: m\nstatus: running");
  // present in the active bundle → active value
  expect(t("only.here")).toBe("x");
  // present nowhere → the literal key
  expect(t("nope.missing.key")).toBe("nope.missing.key");
});

// ── locale switch ──

test("setLocale/getLocale switch the active locale; an explicit locale arg overrides", () => {
  registerBundle("alt", { "feishu.auth.failed": "ALT" });
  expect(getLocale()).toBe("en");
  setLocale("alt");
  expect(getLocale()).toBe("alt");
  expect(t("feishu.auth.failed")).toBe("ALT"); // active locale
  expect(t("feishu.auth.failed", undefined, "en")).toBe(
    "[FYI] Authorization failed\nnote: try again or contact an operator",
  ); // explicit override
});

// ── mail-prompt shape + key coverage ──

test("auth-required is the only [REQ]; errors are [FYI]; completed actions are [DONE]", () => {
  expect(t("feishu.auth.required", { code: "ABC123" })).toBe(
    "[REQ] Authorization required\ncode: ABC123\naction: ask an operator to run `mesh channels feishu approve ABC123`",
  );
  expect(t("feishu.cmd.failed", { error: "boom" }).startsWith("[FYI] ")).toBe(true);
  expect(t("feishu.cmd.stopDone", { mesh: "m" })).toBe("[DONE] Mesh stopped\nmesh: m\nstatus: stopped");
});

test("the en bundle covers every Category-A/C/card/tool key the migration will reference", () => {
  const required = [
    "feishu.cmd.status", "feishu.cmd.startAlready", "feishu.cmd.startDone", "feishu.cmd.stopAlready",
    "feishu.cmd.stopDone", "feishu.cmd.restartDone", "feishu.cmd.newSessionRunning",
    "feishu.cmd.newSessionStopped", "feishu.cmd.failed", "feishu.cmd.help", "feishu.mesh.autostartFailed",
    "feishu.deliver.failed", "feishu.image.disabled", "feishu.image.unprocessable",
    "feishu.image.downloadFailed", "feishu.assistant.disabled", "feishu.assistant.busy",
    "feishu.assistant.failed", "feishu.auth.failed", "feishu.auth.required", "card.fallbackTitle",
    "feishu.prompt.group", "feishu.prompt.p2p", "feishu.prompt.image", "tool.hint", "tool.hintNamed",
  ];
  for (const key of required) {
    expect(hasKey(key, "en")).toBe(true);
    expect(en[key as keyof typeof en]).toBeDefined();
  }
});

test("no en value contains a Han character (all generated copy is English)", () => {
  for (const [key, value] of Object.entries(en)) {
    expect(/[一-鿿]/.test(value), `${key} should be English`).toBe(false);
  }
});
