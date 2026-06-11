import { expect, test } from "bun:test";
import { HARNESSES } from "./harness";
import { probeHarnesses } from "./harness-probe";
import type { HarnessId } from "./acp/types";

test("probeHarnesses reports one installed flag for each registered harness", () => {
  const installed = new Set(["codex-acp", "kimi"]);
  const rows = probeHarnesses((command) => installed.has(command) ? `/bin/${command}` : null);

  expect(rows).toEqual(Object.entries(HARNESSES).map(([id, spec]) => ({
    id: id as HarnessId,
    installed: installed.has(spec.command),
  })));
});
