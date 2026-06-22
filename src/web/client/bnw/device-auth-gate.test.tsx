// Step 7.4-A.2b-ii (2/2) — focused SSR tests for the /bnw device-auth gate (mockup 12). The
// populated gate (device code / bootstrap / remembered) is effect-driven and covered by bnw.e2e
// against an unauthenticated context; SSR (no effects) renders the pre-fetch shell states.
import { test, expect } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import type { ReactElement } from "react";
import { BnwBoot, BnwDeviceAuthGate } from "./device-auth-gate";
import { I18nContext, translate, type TFn } from "../i18n";
const EN = { lang: "en" as const, t: ((k, vars) => translate(k, "en", vars)) as TFn };
const r = (el: ReactElement) => renderToStaticMarkup(<I18nContext.Provider value={EN}>{el}</I18nContext.Provider>);

test("BnwBoot SSR: checking shell (probes authorization before mounting)", () => {
  const out = r(<BnwBoot><div data-child>app</div></BnwBoot>);
  expect(out).toContain('data-device-auth="gate"');
  expect(out).toContain("Checking device authorization…");
  expect(out).not.toContain("data-child"); // children only render once authorized
});

test("BnwDeviceAuthGate SSR: gate shell + requesting state (effects fetch the code)", () => {
  const out = r(<BnwDeviceAuthGate onApproved={() => {}} />);
  expect(out).toContain('data-device-auth="gate"');
  expect(out).toContain("Device authorization");
  expect(out).toContain("Requesting device code…");
});
