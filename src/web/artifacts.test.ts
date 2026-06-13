import { mkdir, mkdtemp, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test, expect } from "bun:test";
import { artifactAgentDir, assertSafeArtifactName, resolveArtifactFile } from "./artifacts";

const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0]);

async function withRoot(fn: (root: string) => Promise<void>) {
  const root = await mkdtemp(join(tmpdir(), "mesh-artifacts-"));
  try {
    await fn(root);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

async function expectCode(root: string, relPath: string, code: string) {
  try {
    await resolveArtifactFile(root, "demo", "agent-1", relPath);
    throw new Error("expected resolveArtifactFile to reject");
  } catch (err: any) {
    expect(err?.code).toBe(code);
  }
}

test("assertSafeArtifactName accepts mesh-safe names and rejects traversal-ish names", () => {
  for (const name of ["mesh-dev", "agent_1", "a.b"]) expect(() => assertSafeArtifactName(name)).not.toThrow();
  for (const name of ["", ".", "..", "bad/name", "bad\\name", "bad..name", "space name"]) {
    expect(() => assertSafeArtifactName(name)).toThrow(/invalid/i);
  }
});

test("artifactAgentDir stays under the artifacts root", async () => {
  await withRoot(async (root) => {
    const dir = artifactAgentDir(root, "demo", "agent-1");
    expect(dir).toBe(join(root, "artifacts", "demo", "agent-1"));
    expect(() => artifactAgentDir(root, "../demo", "agent-1")).toThrow(/invalid/i);
    expect(() => artifactAgentDir(root, "demo", "../agent")).toThrow(/invalid/i);
  });
});

test("resolveArtifactFile serves exact safe files and rejects traversal, absolute paths, and NUL", async () => {
  await withRoot(async (root) => {
    const dir = artifactAgentDir(root, "demo", "agent-1");
    await mkdir(dir, { recursive: true });
    await writeFile(join(dir, "report.md"), "# Report\n");
    const file = await resolveArtifactFile(root, "demo", "agent-1", "report.md");
    expect(file.path).toBe(join(dir, "report.md"));
    expect(new TextDecoder().decode(file.bytes)).toBe("# Report\n");

    await expectCode(root, "../outside.md", "traversal");
    await expectCode(root, "%2e%2e/outside.md", "traversal");
    await expectCode(root, "bad%00name.md", "traversal");
    await expectCode(root, "/etc/passwd", "traversal");
  });
});

test("resolveArtifactFile rejects symlinks, non-whitelist, SVG, bad magic, and oversized files", async () => {
  await withRoot(async (root) => {
    const dir = artifactAgentDir(root, "demo", "agent-1");
    await mkdir(join(dir, "real"), { recursive: true });
    await writeFile(join(dir, "real", "target.md"), "ok\n");
    await symlink(join(dir, "real", "target.md"), join(dir, "linked.md"));
    await expectCode(root, "linked.md", "symlink");

    await writeFile(join(dir, "secret.exe"), "exists");
    await expectCode(root, "secret.exe", "enotfound");
    await writeFile(join(dir, "bad.svg"), "<svg></svg>");
    await expectCode(root, "bad.svg", "enotfound");
    await writeFile(join(dir, "fake.png"), "not a png");
    await expectCode(root, "fake.png", "enotfound");
    await writeFile(join(dir, "huge.log"), new Uint8Array(5 * 1024 * 1024 + 1));
    await expectCode(root, "huge.log", "toobig");
  });
});

test("resolveArtifactFile is exact-only and does not fuzzy-search bare basenames", async () => {
  await withRoot(async (root) => {
    const dir = artifactAgentDir(root, "demo", "agent-1");
    await mkdir(join(dir, "nested"), { recursive: true });
    await writeFile(join(dir, "nested", "report.md"), "# nested\n");
    await expectCode(root, "report.md", "enotfound");
    expect((await resolveArtifactFile(root, "demo", "agent-1", "nested/report.md")).path).toBe(join(dir, "nested", "report.md"));
  });
});

test("resolveArtifactFile rejects escape when the agent artifact base is replaced by a symlink", async () => {
  await withRoot(async (root) => {
    const outside = await mkdtemp(join(tmpdir(), "mesh-artifacts-outside-"));
    try {
      await mkdir(join(root, "artifacts", "demo"), { recursive: true });
      await writeFile(join(outside, "secret.md"), "outside\n");
      await symlink(outside, join(root, "artifacts", "demo", "agent-1"));
      const base = join(root, "artifacts", "demo", "agent-1");
      expect(await realpath(base)).toBe(await realpath(outside));
      await expectCode(root, "secret.md", "symlink");
    } finally {
      await rm(outside, { recursive: true, force: true });
    }
  });
});
