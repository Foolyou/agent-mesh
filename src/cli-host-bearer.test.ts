// Adversarial tests for the host-key-derived CLI lifecycle bearer (design §A Approach 2). The bearer is
// a cryptographic proof of `keys.json` possession (HMAC over scoped, short-TTL claims) — NOT a loopback
// bypass. These vectors prove a forged/tampered/expired/off-scope/wrong-key bearer is rejected, while a
// faithfully-signed one round-trips, and that a key rotation keeps an outstanding bearer valid.
import { test, expect } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHmac, hkdfSync } from "node:crypto";
import { ensureKeys, loadKeys, rotateKeys, type KeysFile } from "./auth-codes";
import {
  signHostBearer,
  verifyHostBearer,
  verifyHostBearerFromRoot,
  isHostBearer,
  HOST_BEARER_SCOPE,
  HOST_BEARER_AUDIENCE,
} from "./cli-host-bearer";

async function withRoot<T>(fn: (root: string) => Promise<T>): Promise<T> {
  const root = await mkdtemp(join(tmpdir(), "mesh-hostbearer-"));
  try {
    return await fn(root);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

const nowSec = () => Math.floor(Date.now() / 1000);

/** Mirror the module's signing so a test can forge a token with VALID mac over ARBITRARY claims (to
 *  prove the field checks reject scope/aud/kid/iat manipulation even when the mac itself verifies). */
async function forge(root: string, claims: Record<string, unknown>, opts: { signWithKid?: string } = {}): Promise<string> {
  const keys = (await loadKeys(root))!;
  const signKid = opts.signWithKid ?? keys.active;
  const raw = Buffer.from(keys.keys[signKid].secret, "base64");
  const sub = Buffer.from(hkdfSync("sha256", raw, Buffer.alloc(0), "mesh-cli-lifecycle-bearer-v1", 32));
  const claimsB64 = Buffer.from(JSON.stringify(claims), "utf8").toString("base64url");
  const mac = createHmac("sha256", sub).update(`mhk1.${claimsB64}`).digest();
  return `mhk1.${claimsB64}.${mac.toString("base64url")}`;
}
const goodClaims = (over: Record<string, unknown> = {}) => ({
  v: 1, kid: "k1", iat: nowSec(), exp: nowSec() + 60, scope: HOST_BEARER_SCOPE, aud: HOST_BEARER_AUDIENCE, nonce: "n", ...over,
});

// ── isHostBearer ──

test("isHostBearer distinguishes mhk1 bearers from device tokens", () => {
  expect(isHostBearer("mhk1.abc.def")).toBe(true);
  expect(isHostBearer("aGVsbG8td29ybGQ")).toBe(false); // bare base64url device token
  expect(isHostBearer(undefined)).toBe(false);
  expect(isHostBearer("mhk1")).toBe(false); // prefix without the dot
});

// ── round-trip + rotation ──

test("sign → verify round-trips and reports the lifecycle scope", async () => {
  await withRoot(async (root) => {
    const token = await signHostBearer(root);
    expect(isHostBearer(token)).toBe(true);
    const v = await verifyHostBearerFromRoot(root, token);
    expect(v).toEqual({ ok: true, scope: HOST_BEARER_SCOPE });
  });
});

test("a bearer signed with k1 still verifies after a key rotation (kid retained)", async () => {
  await withRoot(async (root) => {
    await ensureKeys(root); // active = k1
    const token = await signHostBearer(root);
    const rotated = await rotateKeys(root); // active → k2, k1 retained
    expect(rotated.active).not.toBe("k1");
    expect(await verifyHostBearerFromRoot(root, token)).toMatchObject({ ok: true });
  });
});

// ── adversarial rejections ──

test("a tampered claims segment is rejected (mac no longer matches)", async () => {
  await withRoot(async (root) => {
    const token = await signHostBearer(root);
    const [p, claimsB64, mac] = token.split(".");
    const flipped = claimsB64.slice(0, -1) + (claimsB64.endsWith("A") ? "B" : "A");
    expect((await verifyHostBearerFromRoot(root, `${p}.${flipped}.${mac}`)).ok).toBe(false);
  });
});

test("a forged mac is rejected", async () => {
  await withRoot(async (root) => {
    const token = await signHostBearer(root);
    const [p, claimsB64] = token.split(".");
    const forgedMac = Buffer.alloc(32, 7).toString("base64url");
    expect((await verifyHostBearerFromRoot(root, `${p}.${claimsB64}.${forgedMac}`)).ok).toBe(false);
  });
});

test("a truncated mac is rejected (length mismatch, no throw)", async () => {
  await withRoot(async (root) => {
    const token = await signHostBearer(root);
    const [p, claimsB64] = token.split(".");
    expect((await verifyHostBearerFromRoot(root, `${p}.${claimsB64}.AA`)).ok).toBe(false);
  });
});

test("an expired bearer is rejected (replay of an expired token fails)", async () => {
  await withRoot(async (root) => {
    await ensureKeys(root);
    const token = await forge(root, goodClaims({ iat: nowSec() - 120, exp: nowSec() - 60 }));
    expect((await verifyHostBearerFromRoot(root, token)).ok).toBe(false);
  });
});

test("a VALID-mac bearer with the wrong scope is rejected", async () => {
  await withRoot(async (root) => {
    await ensureKeys(root);
    const token = await forge(root, goodClaims({ scope: "mesh.admin" }));
    expect((await verifyHostBearerFromRoot(root, token)).ok).toBe(false);
  });
});

test("a VALID-mac bearer with the wrong audience is rejected", async () => {
  await withRoot(async (root) => {
    await ensureKeys(root);
    const token = await forge(root, goodClaims({ aud: "someone-else" }));
    expect((await verifyHostBearerFromRoot(root, token)).ok).toBe(false);
  });
});

test("an unknown / rotated-out kid is rejected even with a real mac under another key", async () => {
  await withRoot(async (root) => {
    await ensureKeys(root); // only k1 exists
    // claims claim kid="k9" (absent) but are mac'd with the real k1 sub-key → verify looks up k9 → deny
    const token = await forge(root, goodClaims({ kid: "k9" }), { signWithKid: "k1" });
    expect((await verifyHostBearerFromRoot(root, token)).ok).toBe(false);
  });
});

test("an implausibly future-dated iat is rejected", async () => {
  await withRoot(async (root) => {
    await ensureKeys(root);
    const token = await forge(root, goodClaims({ iat: nowSec() + 3600, exp: nowSec() + 3660 }));
    expect((await verifyHostBearerFromRoot(root, token)).ok).toBe(false);
  });
});

test("malformed tokens and an absent key store are rejected without throwing", async () => {
  const keys: KeysFile | undefined = undefined;
  expect(verifyHostBearer(keys, "mhk1.a.b")).toEqual({ ok: false });
  await withRoot(async (root) => {
    await ensureKeys(root);
    const k = await loadKeys(root);
    expect(verifyHostBearer(k, "not-a-bearer")).toEqual({ ok: false });
    expect(verifyHostBearer(k, "mhk1.only-two")).toEqual({ ok: false });
    expect(verifyHostBearer(k, "mhk1.@@@.@@@")).toEqual({ ok: false });
  });
});
