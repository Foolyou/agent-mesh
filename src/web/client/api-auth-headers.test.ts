// Regression guard (commit 3 rework): every client-side `fetch(` must attach Bearer auth via
// authHeaders(), or the server's device-token gate will 401 it on an exposed bind. All client
// fetches today target /api/*, so the invariant is simply: no bare fetch() without authHeaders.
// (Internal device-auth.ts calls go through an injected `fetchFn(`, which this scan ignores.)
import { test, expect } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const clientDir = dirname(fileURLToPath(import.meta.url));
const sources = readdirSync(clientDir).filter((f) => /\.(ts|tsx)$/.test(f) && !/\.test\.(ts|tsx)$/.test(f));

test("every client fetch() attaches authHeaders (no bare /api/* request)", () => {
  const offenders: string[] = [];
  for (const file of sources) {
    const src = readFileSync(join(clientDir, file), "utf8");
    for (const m of src.matchAll(/\bfetch\(/g)) {
      const idx = m.index ?? 0;
      // a generous window covers the multi-line options object where headers live
      const window = src.slice(idx, idx + 400);
      if (!window.includes("authHeaders")) {
        const line = src.slice(0, idx).split("\n").length;
        offenders.push(`${file}:${line}`);
      }
    }
  }
  expect(offenders, `client fetch() missing authHeaders at: ${offenders.join(", ")}`).toEqual([]);
});
