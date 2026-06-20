import { test, expect } from "bun:test";
import { scanRawTokens, scanProject, RAW_TOKEN_RE } from "./raw-token-guard";

// Proof the guard CATCHES a synthetic violation, ALLOWS a reasoned opt-out, and
// passes clean/semantic-only code. (Synthetic raw-* strings are built by
// concatenation so this test file is itself clean for the project scan.)
const RAW = "raw-" + "slate-500";
const RAW_ACCENT = "raw-" + "signal-teal-400";

test("guard catches a synthetic raw-* utility usage", () => {
  const v = scanRawTokens(`<div className="bg-${RAW} text-text-primary" />`);
  expect(v.length).toBe(1);
  expect(v[0].match).toBe(RAW);
});

test("guard catches a raw-* CSS var reference", () => {
  expect(scanRawTokens(`color: var(--${RAW_ACCENT});`).length).toBe(1);
});

test("guard ALLOWS an explicit reasoned opt-out on the line", () => {
  const ok = `<div className="bg-${RAW}" /> {/* raw-token-allow: one-off brand chrome, no semantic token exists */}`;
  expect(scanRawTokens(ok)).toEqual([]);
});

test("a bare `raw-token-allow:` with NO reason does not suppress (must give a reason)", () => {
  // ALLOW_RE requires a non-empty reason after the colon
  expect(scanRawTokens(`bg-${RAW} // raw-token-allow:`).length).toBe(1);
});

test("clean / semantic-only code produces no violations", () => {
  expect(scanRawTokens(`<div className="bg-surface text-text-primary border-border-strong bg-accent text-on-accent" />`)).toEqual([]);
  // not a raw scale token (no ramp+stop) — must not false-positive
  expect(scanRawTokens(`const raw = readFileSync(p); // draws raw bytes`)).toEqual([]);
});

test("the actual web source tree has NO forbidden raw-* references", async () => {
  const violations = await scanProject();
  if (violations.length) console.error(violations.map((v) => `${v.file}:${v.line} ${v.match}`).join("\n"));
  expect(violations).toEqual([]);
});
