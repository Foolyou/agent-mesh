import { expect, test } from "bun:test";
import { mkdtemp, rm, stat, writeFile, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { generateToken, hashToken } from "./auth-codes";
import {
  bootstrapTokenValid,
  devicesPath,
  emptyDevices,
  emptyFeishuAuth,
  feishuAllowKey,
  feishuAuthPath,
  findApprovedDeviceId,
  isFeishuAllowed,
  readDevices,
  readFeishuAuth,
  sanitizeDevices,
  sanitizeFeishuAuth,
  updateDevices,
  updateFeishuAuth,
  writeDevices,
  writeFeishuAuth,
  type DevicesFile,
  type FeishuAuthFile,
} from "./auth-store";

async function tmp(): Promise<string> {
  return mkdtemp(join(tmpdir(), "auth-store-"));
}

// Base offsets on the real clock: writeDevices/writeFeishuAuth sanitize with the default Date.now(),
// so "live" pending must be in the future relative to wall-clock, not a fixed instant.
const NOW = Date.now();
const future = (ms: number) => new Date(NOW + ms).toISOString();
const past = (ms: number) => new Date(NOW - ms).toISOString();

// ── devices: defaults / round-trip / perms ───────────────────────────────────

test("readDevices on a cold root returns an empty store", async () => {
  const root = await tmp();
  try {
    expect(await readDevices(root)).toEqual(emptyDevices());
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("writeDevices then readDevices round-trips, file is 0600", async () => {
  const root = await tmp();
  try {
    const token = generateToken();
    const file: DevicesFile = {
      version: 1,
      devices: { dv_1: { status: "approved", tokenHash: hashToken(token), createdAt: future(0), approvedAt: future(0) } },
      pending: {},
    };
    await writeDevices(root, file);
    const back = await readDevices(root, NOW);
    expect(back.devices.dv_1.status).toBe("approved");
    expect(back.devices.dv_1.tokenHash).toBe(hashToken(token));
    const st = await stat(devicesPath(root));
    expect(st.mode & 0o777).toBe(0o600);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

// ── devices: sanitize / GC ────────────────────────────────────────────────────

test("sanitizeDevices drops records with no tokenHash and normalizes an unknown status to revoked", () => {
  const file = sanitizeDevices(
    {
      version: 1,
      devices: {
        good: { status: "approved", tokenHash: "sha256:abc", createdAt: future(0) },
        weird: { status: "banana", tokenHash: "sha256:def", createdAt: future(0) },
        broken: { status: "approved", createdAt: future(0) }, // no tokenHash → dropped
      },
      pending: {},
    },
    NOW,
  );
  expect(Object.keys(file.devices).sort()).toEqual(["good", "weird"]);
  expect(file.devices.weird.status).toBe("revoked"); // unknown status never grants access
});

test("readDevices GCs expired pending entries but keeps live ones", async () => {
  const root = await tmp();
  try {
    await writeDevices(root, {
      version: 1,
      devices: {},
      pending: {
        LIVE: { deviceId: "dv_a", tokenHash: "sha256:a", createdAt: past(1000), expiresAt: future(60_000) },
        DEAD: { deviceId: "dv_b", tokenHash: "sha256:b", createdAt: past(1000), expiresAt: past(1000) },
      },
    });
    const back = await readDevices(root, NOW);
    expect(Object.keys(back.pending)).toEqual(["LIVE"]); // expired one GC'd
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

// ── devices: update RMW + concurrency ─────────────────────────────────────────

test("updateDevices applies the mutation and persists it", async () => {
  const root = await tmp();
  try {
    await updateDevices(root, (f) => {
      f.devices.dv_1 = { status: "approved", tokenHash: "sha256:x", createdAt: future(0), approvedAt: future(0) };
    });
    expect((await readDevices(root, NOW)).devices.dv_1.status).toBe("approved");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("concurrent updateDevices do not lose writes (lock serializes the read-modify-write)", async () => {
  const root = await tmp();
  try {
    await Promise.all(
      Array.from({ length: 12 }, (_, i) =>
        updateDevices(root, (f) => {
          f.devices[`dv_${i}`] = { status: "approved", tokenHash: `sha256:${i}`, createdAt: future(0) };
        }),
      ),
    );
    const back = await readDevices(root, NOW);
    expect(Object.keys(back.devices)).toHaveLength(12); // every concurrent add survived
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

// ── devices: token lookup + bootstrap ─────────────────────────────────────────

test("findApprovedDeviceId matches only approved devices by hashed token", () => {
  const tApproved = generateToken();
  const tRevoked = generateToken();
  const file: DevicesFile = {
    version: 1,
    devices: {
      ok: { status: "approved", tokenHash: hashToken(tApproved), createdAt: future(0) },
      no: { status: "revoked", tokenHash: hashToken(tRevoked), createdAt: future(0) },
    },
    pending: {},
  };
  expect(findApprovedDeviceId(file, tApproved)).toBe("ok");
  expect(findApprovedDeviceId(file, tRevoked)).toBeUndefined(); // revoked never matches
  expect(findApprovedDeviceId(file, generateToken())).toBeUndefined();
});

test("findApprovedDeviceId scans the whole allowlist (no early return) and matches regardless of position", () => {
  // The match sits LAST among many approved entries: a correct full-scan still returns it. (This is a
  // behavior proxy for the no-early-return property that keeps lookup time position-independent.)
  const target = generateToken();
  const devices: DevicesFile["devices"] = {};
  for (let i = 0; i < 10; i++) devices[`dv_${i}`] = { status: "approved", tokenHash: hashToken(generateToken()), createdAt: future(0) };
  devices.dv_last = { status: "approved", tokenHash: hashToken(target), createdAt: future(0) };
  const file: DevicesFile = { version: 1, devices, pending: {} };
  expect(findApprovedDeviceId(file, target)).toBe("dv_last");
});

test("bootstrapTokenValid: true only for a live unconsumed token; false when expired/consumed/wrong", () => {
  const token = generateToken();
  const base: DevicesFile = { ...emptyDevices(), bootstrap: { tokenHash: hashToken(token), createdAt: past(1000), expiresAt: future(60_000) } };
  expect(bootstrapTokenValid(base, token, NOW)).toBe(true);
  expect(bootstrapTokenValid(base, generateToken(), NOW)).toBe(false); // wrong token
  expect(bootstrapTokenValid({ ...base, bootstrap: { ...base.bootstrap!, expiresAt: past(1000) } }, token, NOW)).toBe(false); // expired
  expect(bootstrapTokenValid({ ...base, bootstrap: { ...base.bootstrap!, consumedAt: past(500) } }, token, NOW)).toBe(false); // consumed
  expect(bootstrapTokenValid(emptyDevices(), token, NOW)).toBe(false); // none set
});

test("a bootstrap token round-trips through write/read and stays usable", async () => {
  const root = await tmp();
  try {
    const token = generateToken();
    await updateDevices(root, (f) => {
      f.bootstrap = { tokenHash: hashToken(token), createdAt: future(0), expiresAt: future(60_000) };
    }, NOW);
    const back = await readDevices(root, NOW);
    expect(bootstrapTokenValid(back, token, NOW)).toBe(true);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

// ── feishu: composite key ─────────────────────────────────────────────────────

test("feishuAllowKey is deterministic, text-safe (base64url), and order-sensitive", () => {
  const k = feishuAllowKey("feishu:cli_abc", "ou_123");
  expect(k).toBe(feishuAllowKey("feishu:cli_abc", "ou_123")); // stable
  expect(k).toMatch(/^[A-Za-z0-9_-]+$/); // no raw delimiter, no NUL
  expect(k).not.toBe(feishuAllowKey("ou_123", "feishu:cli_abc")); // (channel, open) ≠ (open, channel)
  expect(JSON.parse(Buffer.from(k, "base64url").toString("utf8"))).toEqual(["feishu:cli_abc", "ou_123"]);
});

// ── feishu: round-trip / queries / GC ─────────────────────────────────────────

test("isFeishuAllowed is true only for an approved (channelKey, openId)", async () => {
  const root = await tmp();
  try {
    const key = feishuAllowKey("feishu:cli_abc", "ou_123");
    await writeFeishuAuth(root, {
      version: 1,
      allow: { [key]: { channelKey: "feishu:cli_abc", openId: "ou_123", status: "approved", approvedAt: future(0) } },
      pending: {},
    });
    const back = await readFeishuAuth(root, NOW);
    expect(isFeishuAllowed(back, "feishu:cli_abc", "ou_123")).toBe(true);
    expect(isFeishuAllowed(back, "feishu:cli_abc", "ou_999")).toBe(false); // unknown
    expect(isFeishuAllowed(back, "feishu:other", "ou_123")).toBe(false); // different channel
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("sanitizeFeishuAuth canonically re-keys allow entries: a wrong stored key heals to the entry fields", () => {
  const file = sanitizeFeishuAuth(
    {
      version: 1,
      // stored under a bogus/drifted key, but the entry fields are valid
      allow: { "WRONG_DRIFTED_KEY": { channelKey: "feishu:cli_abc", openId: "ou_123", status: "approved", approvedAt: future(0) } },
      pending: {},
    },
    NOW,
  );
  const canonical = feishuAllowKey("feishu:cli_abc", "ou_123");
  expect(Object.keys(file.allow)).toEqual([canonical]); // re-keyed; the wrong key is not retained
  expect(file.allow.WRONG_DRIFTED_KEY).toBeUndefined();
  expect(isFeishuAllowed(file, "feishu:cli_abc", "ou_123")).toBe(true); // canonical lookup finds it
});

test("a revoked feishu entry is not allowed", () => {
  const key = feishuAllowKey("feishu:cli_abc", "ou_123");
  const file: FeishuAuthFile = {
    version: 1,
    allow: { [key]: { channelKey: "feishu:cli_abc", openId: "ou_123", status: "revoked", approvedAt: future(0) } },
    pending: {},
  };
  expect(isFeishuAllowed(file, "feishu:cli_abc", "ou_123")).toBe(false);
});

test("feishu pending preserves encryptedToken and GCs expired entries on read", async () => {
  const root = await tmp();
  try {
    await writeFeishuAuth(root, {
      version: 1,
      allow: {},
      pending: {
        LIVE: { encryptedToken: "ENV_LIVE", channelKey: "feishu:cli_abc", openId: "ou_1", appId: "cli_abc", firstSeenAt: past(1000), expiresAt: future(60_000) },
        DEAD: { encryptedToken: "ENV_DEAD", channelKey: "feishu:cli_abc", openId: "ou_2", appId: "cli_abc", firstSeenAt: past(1000), expiresAt: past(1000) },
      },
    });
    const back = await readFeishuAuth(root, NOW);
    expect(Object.keys(back.pending)).toEqual(["LIVE"]);
    expect(back.pending.LIVE.encryptedToken).toBe("ENV_LIVE"); // full token retained as source of truth
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("sanitizeFeishuAuth drops pending entries missing the encryptedToken", () => {
  const file = sanitizeFeishuAuth(
    {
      version: 1,
      allow: {},
      pending: {
        bad: { channelKey: "feishu:cli_abc", openId: "ou_1", appId: "cli_abc", firstSeenAt: past(1000), expiresAt: future(60_000) },
      },
    },
    NOW,
  );
  expect(Object.keys(file.pending)).toEqual([]); // no encryptedToken → dropped
});

test("updateFeishuAuth approve flow: add pending then promote to allow", async () => {
  const root = await tmp();
  try {
    await updateFeishuAuth(root, (f) => {
      f.pending.AB12CD = { encryptedToken: "ENV", channelKey: "feishu:cli_abc", openId: "ou_1", appId: "cli_abc", firstSeenAt: future(0), expiresAt: future(60_000) };
    }, NOW);
    await updateFeishuAuth(root, (f) => {
      delete f.pending.AB12CD;
      f.allow[feishuAllowKey("feishu:cli_abc", "ou_1")] = { channelKey: "feishu:cli_abc", openId: "ou_1", status: "approved", approvedAt: future(1) };
    }, NOW);
    const back = await readFeishuAuth(root, NOW);
    expect(Object.keys(back.pending)).toEqual([]);
    expect(isFeishuAllowed(back, "feishu:cli_abc", "ou_1")).toBe(true);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

// ── corrupt files never throw ─────────────────────────────────────────────────

test("readDevices / readFeishuAuth fall back to empty on a corrupt file", async () => {
  const root = await tmp();
  try {
    await mkdir(join(root, "auth"), { recursive: true });
    await writeFile(devicesPath(root), "{ not json", "utf8");
    await writeFile(feishuAuthPath(root), "}}}", "utf8");
    expect(await readDevices(root)).toEqual(emptyDevices());
    expect(await readFeishuAuth(root)).toEqual(emptyFeishuAuth());
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
