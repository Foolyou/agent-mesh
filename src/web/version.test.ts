import { expect, test } from "bun:test";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { appVersionFrom, defaultAppVersionFrom } from "./version";

test("appVersionFrom prefers an explicit env build id", async () => {
  expect(appVersionFrom({ env: { MESH_BUILD_ID: "env-build" }, candidates: [] })).toBe("env-build");
});

test("appVersionFrom reads the deployed binary sidecar build id", async () => {
  const root = await mkdtemp(join(tmpdir(), "mesh-version-"));
  try {
    const bin = join(root, "mesh");
    await writeFile(bin, "binary");
    await writeFile(`${bin}.build-id`, "deploy-20260610\n");
    expect(appVersionFrom({ env: {}, candidates: [bin] })).toBe("deploy-20260610");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("defaultAppVersionFrom includes the assistant wire protocol version", () => {
  expect(defaultAppVersionFrom("binary:1:2")).toBe("binary:1:2:assistant-wire-v1");
});
