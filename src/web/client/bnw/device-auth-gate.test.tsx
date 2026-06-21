// Step 7.4-A.2b-ii (2/2) — focused SSR tests for the /bnw device-auth gate (mockup 12). The
// populated gate (device code / bootstrap / remembered) is effect-driven and covered by bnw.e2e
// against an unauthenticated context; SSR (no effects) renders the pre-fetch shell states.
import { test, expect } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { BnwBoot, BnwDeviceAuthGate } from "./device-auth-gate";

test("BnwBoot SSR: checking shell (probes authorization before mounting)", () => {
  const out = renderToStaticMarkup(<BnwBoot><div data-child>app</div></BnwBoot>);
  expect(out).toContain('data-device-auth="gate"');
  expect(out).toContain("正在检查设备授权…");
  expect(out).not.toContain("data-child"); // children only render once authorized
});

test("BnwDeviceAuthGate SSR: gate shell + requesting state (effects fetch the code)", () => {
  const out = renderToStaticMarkup(<BnwDeviceAuthGate onApproved={() => {}} />);
  expect(out).toContain('data-device-auth="gate"');
  expect(out).toContain("设备授权");
  expect(out).toContain("正在请求设备码…");
});
