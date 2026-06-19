import { expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readFile } from "node:fs/promises";
import { encryptAuthCode, ensureKeys, generateToken, hashToken, loadKeys, verifyTokenHash } from "./auth-codes";
import { bootstrapTokenValid, devicesPath, isFeishuAllowed, readDevices, readFeishuAuth, updateDevices, updateFeishuAuth } from "./auth-store";
import { runAuthCli } from "./auth-cli";

async function tmp(): Promise<string> {
  return mkdtemp(join(tmpdir(), "auth-cli-"));
}
const nowIso = () => new Date().toISOString();
const future = (ms = 600_000) => new Date(Date.now() + ms).toISOString();

async function seedPendingDevice(root: string, code: string, deviceId: string) {
  await updateDevices(root, (f) => {
    f.pending[code] = { deviceId, tokenHash: hashToken(generateToken()), userAgentClass: "desktop", remoteHint: "tailscale", createdAt: nowIso(), expiresAt: future() };
  });
}

async function seedFeishuPending(root: string, code: string, openId: string, encryptedToken: string) {
  await updateFeishuAuth(root, (f) => {
    f.pending[code] = { encryptedToken, channelKey: "feishu:cli_abc", openId, appId: "cli_abc", firstSeenAt: nowIso(), expiresAt: future() };
  });
}

// ── device list / approve / revoke ────────────────────────────────────────────

test("device list on an empty store shows zero pending/approved and no bootstrap", async () => {
  const root = await tmp();
  try {
    const r = await runAuthCli(root, "device", ["list"]);
    expect(r.exitCode).toBe(0);
    const text = r.out.join("\n");
    expect(text).toContain("Pending devices (0):");
    expect(text).toContain("Approved devices (0):");
    expect(text).toContain("Bootstrap token: none");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("device approve moves a pending code to an approved device and consumes the pending", async () => {
  const root = await tmp();
  try {
    await seedPendingDevice(root, "K7Q-3F9", "dv_1");
    const r = await runAuthCli(root, "device", ["approve", "K7Q-3F9"]);
    expect(r.exitCode).toBe(0);
    expect(r.out.join("\n")).toContain("approved device dv_1");
    const file = await readDevices(root);
    expect(file.devices.dv_1.status).toBe("approved");
    expect(file.devices.dv_1.approvedAt).toBeTruthy();
    expect(Object.keys(file.pending)).toEqual([]); // consumed
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("device approve --label records the operator label", async () => {
  const root = await tmp();
  try {
    await seedPendingDevice(root, "CODE", "dv_2");
    const r = await runAuthCli(root, "device", ["approve", "CODE", "--label", "chrome-macbook"]);
    expect(r.exitCode).toBe(0);
    expect(r.out.join("\n")).toContain("label: chrome-macbook");
    expect((await readDevices(root)).devices.dv_2.label).toBe("chrome-macbook");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("device approve of an unknown / already-consumed code fails cleanly (no crash)", async () => {
  const root = await tmp();
  try {
    await seedPendingDevice(root, "ONCE", "dv_3");
    expect((await runAuthCli(root, "device", ["approve", "ONCE"])).exitCode).toBe(0);
    const again = await runAuthCli(root, "device", ["approve", "ONCE"]); // idempotent-ish: clear error
    expect(again.exitCode).toBe(2);
    expect(again.err.join("\n")).toContain("no pending device code 'ONCE'");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("device revoke works by deviceId and by label; unknown target fails", async () => {
  const root = await tmp();
  try {
    await seedPendingDevice(root, "C1", "dv_a");
    await runAuthCli(root, "device", ["approve", "C1", "--label", "laptop"]);
    // by id
    expect((await runAuthCli(root, "device", ["revoke", "dv_a"])).exitCode).toBe(0);
    expect((await readDevices(root)).devices.dv_a.status).toBe("revoked");
    // by label (re-approve a fresh one first)
    await seedPendingDevice(root, "C2", "dv_b");
    await runAuthCli(root, "device", ["approve", "C2", "--label", "phone"]);
    const byLabel = await runAuthCli(root, "device", ["revoke", "phone"]);
    expect(byLabel.exitCode).toBe(0);
    expect(byLabel.out.join("\n")).toContain("dv_b");
    expect((await readDevices(root)).devices.dv_b.status).toBe("revoked");
    // unknown
    const miss = await runAuthCli(root, "device", ["revoke", "nope"]);
    expect(miss.exitCode).toBe(2);
    expect(miss.err.join("\n")).toContain("no device matching 'nope'");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

// ── feishu approve via short-id → decrypt → allow ─────────────────────────────

test("feishu approve decrypts the pending token and allows the decoded (channelKey, openId)", async () => {
  const root = await tmp();
  try {
    const keys = await ensureKeys(root);
    const token = encryptAuthCode(keys, { channelKey: "feishu:cli_abc", openId: "ou_1", appId: "cli_abc", ttlSeconds: 600 });
    await seedFeishuPending(root, "AB12CD", "ou_1", token);
    const r = await runAuthCli(root, "feishu", ["approve", "AB12CD"]);
    expect(r.exitCode).toBe(0);
    expect(r.out.join("\n")).toContain("approved ou_1 on feishu:cli_abc (appId cli_abc)");
    const file = await readFeishuAuth(root);
    expect(isFeishuAllowed(file, "feishu:cli_abc", "ou_1")).toBe(true);
    expect(Object.keys(file.pending)).toEqual([]); // pending consumed
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("feishu approve trusts the DECRYPTED identity, not the advisory pending plaintext", async () => {
  const root = await tmp();
  try {
    const keys = await ensureKeys(root);
    // token encodes ou_REAL; the pending advisory plaintext lies (ou_FAKE)
    const token = encryptAuthCode(keys, { channelKey: "feishu:cli_abc", openId: "ou_REAL", appId: "cli_abc", ttlSeconds: 600 });
    await updateFeishuAuth(root, (f) => {
      f.pending["X"] = { encryptedToken: token, channelKey: "feishu:cli_abc", openId: "ou_FAKE", appId: "cli_abc", firstSeenAt: nowIso(), expiresAt: future() };
    });
    await runAuthCli(root, "feishu", ["approve", "X"]);
    const file = await readFeishuAuth(root);
    expect(isFeishuAllowed(file, "feishu:cli_abc", "ou_REAL")).toBe(true); // decrypted wins
    expect(isFeishuAllowed(file, "feishu:cli_abc", "ou_FAKE")).toBe(false); // advisory ignored
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("feishu approve with a tampered token fails generically, leaks nothing, and changes no state", async () => {
  const root = await tmp();
  try {
    await ensureKeys(root);
    await seedFeishuPending(root, "BAD", "ou_2", "this-is-not-a-valid-envelope");
    const r = await runAuthCli(root, "feishu", ["approve", "BAD"]);
    expect(r.exitCode).toBe(2);
    const msg = r.err.join("\n");
    expect(msg).toContain("invalid"); // generic AuthCodeError message
    expect(msg).not.toContain("this-is-not-a-valid-envelope"); // no token body leak
    const file = await readFeishuAuth(root);
    expect(isFeishuAllowed(file, "feishu:cli_abc", "ou_2")).toBe(false);
    expect(Object.keys(file.pending)).toContain("BAD"); // pending untouched on failure
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("feishu approve with an expired token reports expired and changes no state", async () => {
  const root = await tmp();
  try {
    const keys = await ensureKeys(root);
    const token = encryptAuthCode(keys, { channelKey: "feishu:cli_abc", openId: "ou_3", appId: "cli_abc", ttlSeconds: 1, now: () => Date.now() - 10_000 });
    await seedFeishuPending(root, "EXP", "ou_3", token);
    const r = await runAuthCli(root, "feishu", ["approve", "EXP"]);
    expect(r.exitCode).toBe(2);
    expect(r.err.join("\n")).toContain("expired");
    expect(isFeishuAllowed(await readFeishuAuth(root), "feishu:cli_abc", "ou_3")).toBe(false);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("feishu approve of an unknown code fails cleanly", async () => {
  const root = await tmp();
  try {
    const r = await runAuthCli(root, "feishu", ["approve", "GHOST"]);
    expect(r.exitCode).toBe(2);
    expect(r.err.join("\n")).toContain("no pending feishu authorization 'GHOST'");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("feishu revoke flips an approved entry; unknown pair fails", async () => {
  const root = await tmp();
  try {
    const keys = await ensureKeys(root);
    const token = encryptAuthCode(keys, { channelKey: "feishu:cli_abc", openId: "ou_9", appId: "cli_abc", ttlSeconds: 600 });
    await seedFeishuPending(root, "C", "ou_9", token);
    await runAuthCli(root, "feishu", ["approve", "C"]);
    expect(isFeishuAllowed(await readFeishuAuth(root), "feishu:cli_abc", "ou_9")).toBe(true);
    const rev = await runAuthCli(root, "feishu", ["revoke", "feishu:cli_abc", "ou_9"]);
    expect(rev.exitCode).toBe(0);
    expect(isFeishuAllowed(await readFeishuAuth(root), "feishu:cli_abc", "ou_9")).toBe(false);
    const miss = await runAuthCli(root, "feishu", ["revoke", "feishu:cli_abc", "ou_none"]);
    expect(miss.exitCode).toBe(2);
    expect(miss.err.join("\n")).toContain("no approved feishu entry");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("feishu list shows pending advisory fields and approved entries, never the token body", async () => {
  const root = await tmp();
  try {
    const keys = await ensureKeys(root);
    const token = encryptAuthCode(keys, { channelKey: "feishu:cli_abc", openId: "ou_x", appId: "cli_abc", ttlSeconds: 600 });
    await seedFeishuPending(root, "LISTME", "ou_x", token);
    const r = await runAuthCli(root, "feishu", ["list"]);
    const text = r.out.join("\n");
    expect(text).toContain("LISTME");
    expect(text).toContain("ou_x");
    expect(text).not.toContain(token); // encrypted token body never printed
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

// ── auth key commands ──────────────────────────────────────────────────────────

test("auth list reports no store before any key, then active/known kids (never the secret)", async () => {
  const root = await tmp();
  try {
    expect((await runAuthCli(root, "auth", ["list"])).out.join("\n")).toContain("no auth encryption key store");
    const keys = await ensureKeys(root);
    const r = await runAuthCli(root, "auth", ["list"]);
    const text = r.out.join("\n");
    expect(text).toContain("active: k1");
    expect(text).toContain("k1");
    expect(text).not.toContain(keys.keys.k1.secret); // secret never printed
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("auth rotate-key creates a new active key and retains the old one", async () => {
  const root = await tmp();
  try {
    const r = await runAuthCli(root, "auth", ["rotate-key"]);
    expect(r.exitCode).toBe(0);
    expect(r.out.join("\n")).toContain("new active k2");
    expect(r.out.join("\n")).toContain("retained 2 key(s)");
    const keys = await loadKeys(root);
    expect(keys!.active).toBe("k2");
    expect(Object.keys(keys!.keys).sort()).toEqual(["k1", "k2"]); // old retained for decrypt overlap
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

// ── auth bootstrap ─────────────────────────────────────────────────────────────

test("auth bootstrap issues a one-time token, prints it once, and stores ONLY its hash", async () => {
  const root = await tmp();
  try {
    const r = await runAuthCli(root, "auth", ["bootstrap"]);
    expect(r.exitCode).toBe(0);
    const token = r.out[1].trim(); // line 0 = header, line 1 = the raw token
    expect(token.length).toBeGreaterThan(20);
    const file = await readDevices(root);
    expect(file.bootstrap).toBeTruthy();
    expect(file.bootstrap!.tokenHash).toBe(hashToken(token));
    expect(verifyTokenHash(token, file.bootstrap!.tokenHash)).toBe(true);
    expect(bootstrapTokenValid(file, token)).toBe(true);
    expect(r.out.join("\n")).toContain("minted"); // first issuance
    // the raw token must NOT be persisted anywhere — neither the loaded model nor the on-disk file
    expect(JSON.stringify(await readDevices(root))).not.toContain(token);
    const raw = await readFile(devicesPath(root), "utf8");
    expect(raw).not.toContain(token);
    expect(raw).toContain(file.bootstrap!.tokenHash);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("auth bootstrap with --ttl present but no value errors and writes nothing", async () => {
  const root = await tmp();
  try {
    const r = await runAuthCli(root, "auth", ["bootstrap", "--ttl"]);
    expect(r.exitCode).toBe(2);
    expect(r.err.join("\n")).toContain("invalid --ttl");
    expect((await readDevices(root)).bootstrap).toBeUndefined(); // nothing written
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("auth bootstrap --ttl sets expiresAt to roughly now + ttl; invalid ttl errors", async () => {
  const root = await tmp();
  try {
    const before = Date.now();
    const r = await runAuthCli(root, "auth", ["bootstrap", "--ttl", "30"]);
    expect(r.exitCode).toBe(0);
    const exp = Date.parse((await readDevices(root)).bootstrap!.expiresAt);
    expect(exp).toBeGreaterThanOrEqual(before + 30_000);
    expect(exp).toBeLessThan(before + 30_000 + 5_000); // ~30s window, not the 10-min default
    for (const bad of ["0", "-5", "abc", "1.5"]) {
      const e = await runAuthCli(root, "auth", ["bootstrap", "--ttl", bad]);
      expect(e.exitCode).toBe(2);
      expect(e.err.join("\n")).toContain("invalid --ttl");
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("auth bootstrap with an invalid ttl on a fresh store writes nothing", async () => {
  const root = await tmp();
  try {
    const e = await runAuthCli(root, "auth", ["bootstrap", "--ttl", "-1"]);
    expect(e.exitCode).toBe(2);
    expect((await readDevices(root)).bootstrap).toBeUndefined(); // no partial write
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("auth bootstrap re-issue supersedes the previous token (old token no longer valid)", async () => {
  const root = await tmp();
  try {
    const first = (await runAuthCli(root, "auth", ["bootstrap"])).out[1].trim();
    const r2 = await runAuthCli(root, "auth", ["bootstrap"]);
    const second = r2.out[1].trim();
    expect(r2.out.join("\n")).toContain("replaced"); // second issuance supersedes the first
    expect(second).not.toBe(first);
    const file = await readDevices(root);
    expect(bootstrapTokenValid(file, second)).toBe(true);
    expect(bootstrapTokenValid(file, first)).toBe(false); // superseded
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

// ── dispatcher / usage ─────────────────────────────────────────────────────────

test("runAuthCli surfaces usage for a missing or unknown action, and rejects unknown groups", async () => {
  const root = await tmp();
  try {
    const noAction = await runAuthCli(root, "device", []);
    expect(noAction.exitCode).toBe(2);
    expect(noAction.err.join("\n")).toContain("usage: mesh device");
    const bogus = await runAuthCli(root, "feishu", ["frobnicate"]);
    expect(bogus.exitCode).toBe(2);
    expect(bogus.err.join("\n")).toContain("usage: mesh feishu");
    const badGroup = await runAuthCli(root, "nope", ["list"]);
    expect(badGroup.exitCode).toBe(2);
    expect(badGroup.err.join("\n")).toContain("unknown command group 'nope'");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
