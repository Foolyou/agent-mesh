import { expect, test } from "bun:test";
import { mkdtemp, rm, readFile, stat, writeFile, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  AuthCodeError,
  authKeysPath,
  decryptAuthCode,
  encryptAuthCode,
  ensureKeys,
  generateToken,
  hashToken,
  loadKeys,
  rotateKeys,
  saveKeys,
  verifyTokenHash,
  type KeysFile,
} from "./auth-codes";

async function tmp(): Promise<string> {
  return mkdtemp(join(tmpdir(), "auth-codes-"));
}

/** A deterministic in-memory key store (no disk) for the pure crypto tests. */
function keyStore(active = "k1", kids: string[] = ["k1"]): KeysFile {
  const keys: KeysFile["keys"] = {};
  for (const kid of kids) {
    // distinct, fixed 32-byte keys so rotation/overlap is observable
    const b = Buffer.alloc(32, kid.charCodeAt(1) ?? 1);
    keys[kid] = { secret: b.toString("base64"), createdAt: "2026-01-01T00:00:00.000Z" };
  }
  return { version: 1, active, keys };
}

const baseInput = { channelKey: "feishu:cli_abc", openId: "ou_123", appId: "cli_abc", ttlSeconds: 600 };

// ── AES-GCM round-trip ───────────────────────────────────────────────────────

test("round-trip: decrypt recovers exactly what was encrypted", () => {
  const ks = keyStore();
  const at = 1_700_000_000_000; // fixed clock (ms)
  const code = encryptAuthCode(ks, { ...baseInput, now: () => at, nonce: "fixed-nonce" });
  const payload = decryptAuthCode(ks, code, { now: () => at });
  expect(payload).toEqual({
    channelKey: "feishu:cli_abc",
    openId: "ou_123",
    appId: "cli_abc",
    iat: Math.floor(at / 1000),
    exp: Math.floor(at / 1000) + 600,
    nonce: "fixed-nonce",
  });
});

test("the code is a base64url envelope JSON with v/kid/iv/tag/ct and no readable plaintext", () => {
  const ks = keyStore();
  const code = encryptAuthCode(ks, baseInput);
  // opaque: the channel/open id must not appear in the code text
  expect(code).not.toContain("ou_123");
  expect(code).not.toContain("feishu");
  const env = JSON.parse(Buffer.from(code, "base64url").toString("utf8"));
  expect(env.v).toBe(1);
  expect(env.kid).toBe("k1");
  expect(typeof env.iv).toBe("string");
  expect(typeof env.tag).toBe("string");
  expect(typeof env.ct).toBe("string");
});

test("two codes for the same input differ (fresh IV + nonce)", () => {
  const ks = keyStore();
  expect(encryptAuthCode(ks, baseInput)).not.toBe(encryptAuthCode(ks, baseInput));
});

// ── tamper / malformed rejection ───────────────────────────────────────────────

test("tamper: flipping a ciphertext byte fails the GCM tag → invalid", () => {
  const ks = keyStore();
  const code = encryptAuthCode(ks, baseInput);
  const env = JSON.parse(Buffer.from(code, "base64url").toString("utf8"));
  const ct = Buffer.from(env.ct, "base64url");
  ct[0] ^= 0xff; // flip a bit
  env.ct = ct.toString("base64url");
  const tampered = Buffer.from(JSON.stringify(env), "utf8").toString("base64url");
  expect(() => decryptAuthCode(ks, tampered)).toThrow(AuthCodeError);
  try {
    decryptAuthCode(ks, tampered);
  } catch (e) {
    expect((e as AuthCodeError).reason).toBe("invalid");
    expect((e as Error).message).not.toContain("k1"); // never leaks key id / raw error
  }
});

test("garbage / truncated / empty input rejects as invalid (never throws a raw crypto error)", () => {
  const ks = keyStore();
  for (const bad of ["", "not-base64url-!@#", "QQ", Buffer.from("{}").toString("base64url")]) {
    let err: unknown;
    try {
      decryptAuthCode(ks, bad);
    } catch (e) {
      err = e;
    }
    expect(err).toBeInstanceOf(AuthCodeError);
    expect((err as AuthCodeError).reason).toBe("invalid");
  }
});

test("wrong key (right kid, different secret) fails the tag → invalid", () => {
  const enc = keyStore();
  const code = encryptAuthCode(enc, baseInput);
  // a store with the same kid but a different secret
  const other: KeysFile = { version: 1, active: "k1", keys: { k1: { secret: Buffer.alloc(32, 9).toString("base64"), createdAt: "x" } } };
  expect(() => decryptAuthCode(other, code)).toThrow(AuthCodeError);
});

// ── expiry ───────────────────────────────────────────────────────────────────

test("expired: a code past its exp rejects as expired (distinct reason)", () => {
  const ks = keyStore();
  const at = 1_700_000_000_000;
  const code = encryptAuthCode(ks, { ...baseInput, ttlSeconds: 10, now: () => at });
  const later = () => at + 11_000; // 11s later, ttl was 10s
  let err: unknown;
  try {
    decryptAuthCode(ks, code, { now: later });
  } catch (e) {
    err = e;
  }
  expect(err).toBeInstanceOf(AuthCodeError);
  expect((err as AuthCodeError).reason).toBe("expired");
  expect((err as Error).message).toBe("authorization code expired");
});

test("still-valid just before exp decrypts fine", () => {
  const ks = keyStore();
  const at = 1_700_000_000_000;
  const code = encryptAuthCode(ks, { ...baseInput, ttlSeconds: 10, now: () => at });
  expect(decryptAuthCode(ks, code, { now: () => at + 9_000 }).openId).toBe("ou_123");
});

// ── unknown kid ────────────────────────────────────────────────────────────────

test("unknown kid: a code whose kid is absent from the store rejects as invalid", () => {
  const enc = keyStore("k2", ["k2"]); // encrypt under k2
  const code = encryptAuthCode(enc, baseInput);
  const dec = keyStore("k1", ["k1"]); // store only knows k1
  let err: unknown;
  try {
    decryptAuthCode(dec, code);
  } catch (e) {
    err = e;
  }
  expect(err).toBeInstanceOf(AuthCodeError);
  expect((err as AuthCodeError).reason).toBe("invalid");
});

// ── key rotation overlap ─────────────────────────────────────────────────────

test("rotation overlap: a code minted under the old key still decrypts after a new active key is added", () => {
  const before = keyStore("k1", ["k1"]);
  const oldCode = encryptAuthCode(before, baseInput); // minted under k1

  // after rotation: k2 active, k1 retained
  const after = keyStore("k2", ["k1", "k2"]);
  expect(decryptAuthCode(after, oldCode).openId).toBe("ou_123"); // old code, old key still works

  const newCode = encryptAuthCode(after, baseInput); // minted under the active key
  const newEnv = JSON.parse(Buffer.from(newCode, "base64url").toString("utf8"));
  expect(newEnv.kid).toBe("k2"); // new codes use the active kid
  expect(decryptAuthCode(after, newCode).openId).toBe("ou_123");
});

test("encrypt with a missing/empty active key throws invalid", () => {
  const empty: KeysFile = { version: 1, active: "", keys: {} };
  expect(() => encryptAuthCode(empty, baseInput)).toThrow(AuthCodeError);
});

// ── token hash utilities ─────────────────────────────────────────────────────

test("hashToken is sha256:<hex>, stable, and never the raw token", () => {
  const t = generateToken();
  const h = hashToken(t);
  expect(h).toMatch(/^sha256:[0-9a-f]{64}$/);
  expect(h).toBe(hashToken(t)); // stable
  expect(h).not.toContain(t);
});

test("generateToken yields distinct base64url secrets", () => {
  expect(generateToken()).not.toBe(generateToken());
  expect(generateToken()).toMatch(/^[A-Za-z0-9_-]+$/);
});

test("verifyTokenHash: true for the right token, false for the wrong one", () => {
  const t = generateToken();
  expect(verifyTokenHash(t, hashToken(t))).toBe(true);
  expect(verifyTokenHash(generateToken(), hashToken(t))).toBe(false);
});

test("verifyTokenHash: a length-mismatched / malformed stored hash returns false (no throw)", () => {
  const t = generateToken();
  expect(verifyTokenHash(t, "sha256:short")).toBe(false);
  expect(verifyTokenHash(t, "")).toBe(false);
  expect(verifyTokenHash(t, hashToken(t) + "extra")).toBe(false);
  // @ts-expect-error exercising the runtime guard for non-string input
  expect(verifyTokenHash(t, null)).toBe(false);
});

// ── key store IO ───────────────────────────────────────────────────────────────

test("ensureKeys: cold store creates an active k1; second call is idempotent", async () => {
  const root = await tmp();
  try {
    const created = await ensureKeys(root);
    expect(created.active).toBe("k1");
    expect(Object.keys(created.keys)).toEqual(["k1"]);
    expect(Buffer.from(created.keys.k1.secret, "base64").length).toBe(32);
    const again = await ensureKeys(root);
    expect(again.keys.k1.secret).toBe(created.keys.k1.secret); // did not regenerate
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("saveKeys writes keys.json with 0600 perms under <root>/auth", async () => {
  const root = await tmp();
  try {
    await ensureKeys(root);
    const st = await stat(authKeysPath(root));
    expect(st.mode & 0o777).toBe(0o600);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("loadKeys: absent → undefined; corrupt → undefined; no-active → undefined", async () => {
  const root = await tmp();
  try {
    expect(await loadKeys(root)).toBeUndefined(); // absent
    await mkdir(join(root, "auth"), { recursive: true });
    await writeFile(authKeysPath(root), "{ not json", "utf8");
    expect(await loadKeys(root)).toBeUndefined(); // corrupt
    await writeFile(authKeysPath(root), JSON.stringify({ version: 1, active: "k9", keys: {} }), "utf8");
    expect(await loadKeys(root)).toBeUndefined(); // active points at a missing key
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("loadKeys drops malformed key entries (bad kid / wrong length / non-string secret)", async () => {
  const root = await tmp();
  try {
    await mkdir(join(root, "auth"), { recursive: true });
    await saveKeys(root, {
      version: 1,
      active: "k1",
      keys: {
        k1: { secret: Buffer.alloc(32, 1).toString("base64"), createdAt: "x" },
        "bad-id": { secret: Buffer.alloc(32, 2).toString("base64"), createdAt: "x" },
        k2: { secret: Buffer.alloc(16, 3).toString("base64"), createdAt: "x" }, // wrong length
      } as KeysFile["keys"],
    });
    const loaded = await loadKeys(root);
    expect(loaded).toBeDefined();
    expect(Object.keys(loaded!.keys).sort()).toEqual(["k1"]); // only the well-formed 32-byte k1 survives
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("rotateKeys: adds k2 as active, keeps k1, and persists; a code under k1 still decrypts via the loaded store", async () => {
  const root = await tmp();
  try {
    const v1 = await ensureKeys(root);
    const oldCode = encryptAuthCode(v1, baseInput); // under k1
    const rotated = await rotateKeys(root);
    expect(rotated.active).toBe("k2");
    expect(Object.keys(rotated.keys).sort()).toEqual(["k1", "k2"]);
    expect(rotated.keys.k1.secret).toBe(v1.keys.k1.secret); // old key retained verbatim

    const reloaded = await loadKeys(root);
    expect(reloaded!.active).toBe("k2");
    expect(decryptAuthCode(reloaded!, oldCode).openId).toBe("ou_123"); // overlap: old code still decrypts
    const newEnv = JSON.parse(Buffer.from(encryptAuthCode(reloaded!, baseInput), "base64url").toString("utf8"));
    expect(newEnv.kid).toBe("k2");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
