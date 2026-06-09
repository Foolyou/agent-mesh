import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test, expect } from "bun:test";
import { extensionWhitelist, pickContentType, resolveAgentFile } from "./agent-files";

const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0]);

async function withRoot(fn: (root: string) => Promise<void>) {
  const root = await mkdtemp(join(tmpdir(), "mesh-agent-files-"));
  try {
    await fn(root);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

async function expectCode(root: string, relPath: string, code: string) {
  try {
    await resolveAgentFile(root, relPath);
    throw new Error("expected resolveAgentFile to reject");
  } catch (err: any) {
    expect(err?.code).toBe(code);
  }
}

test("resolves safe files and picks content types", async () => {
  await withRoot(async (root) => {
    await writeFile(join(root, "report.md"), "# Report\n");
    const file = await resolveAgentFile(root, "report.md");
    expect(file.path).toBe(join(root, "report.md"));
    expect(file.contentType).toBe("text/markdown; charset=utf-8");
    expect(new TextDecoder().decode(file.bytes)).toBe("# Report\n");

    expect(pickContentType(".html")).toBe("text/plain; charset=utf-8");
    expect(pickContentType(".png")).toBe("image/png");
    expect(pickContentType(".exe")).toBeUndefined();
  });
});

test("blocks traversal, encoded traversal, NUL, and absolute relpaths", async () => {
  await withRoot(async (root) => {
    await expectCode(root, "../outside.md", "traversal");
    await expectCode(root, "%2e%2e/outside.md", "traversal");
    await expectCode(root, "bad%00name.md", "traversal");
    await expectCode(root, "/etc/passwd", "traversal");
  });
});

test("rejects final and intermediate symlinks without following them", async () => {
  await withRoot(async (root) => {
    await writeFile(join(root, "target.md"), "inside\n");
    await symlink(join(root, "target.md"), join(root, "link.md"));
    await expectCode(root, "link.md", "symlink");

    await mkdir(join(root, "real"));
    await writeFile(join(root, "real", "nested.md"), "nested\n");
    await symlink(join(root, "real"), join(root, "alias"));
    await expectCode(root, "alias/nested.md", "symlink");
  });
});

test("refuses files larger than 5 MB", async () => {
  await withRoot(async (root) => {
    await writeFile(join(root, "large.log"), new Uint8Array(5 * 1024 * 1024 + 1));
    await expectCode(root, "large.log", "toobig");
  });
});

test("verifies raster image magic bytes", async () => {
  await withRoot(async (root) => {
    await writeFile(join(root, "diagram.png"), PNG);
    const ok = await resolveAgentFile(root, "diagram.png");
    expect(ok.contentType).toBe("image/png");

    await writeFile(join(root, "fake.png"), "not a png");
    await expectCode(root, "fake.png", "enotfound");
  });
});

test("D3 extension allowlist serves expected types and hides misses", async () => {
  await withRoot(async (root) => {
    const allowed = [
      ["a.md", "text/markdown; charset=utf-8"],
      ["a.markdown", "text/markdown; charset=utf-8"],
      ["a.svg", "image/svg+xml"],
      ["a.txt", "text/plain; charset=utf-8"],
      ["a.log", "text/plain; charset=utf-8"],
      ["a.json", "text/plain; charset=utf-8"],
      ["a.csv", "text/plain; charset=utf-8"],
      ["a.yaml", "text/plain; charset=utf-8"],
      ["a.yml", "text/plain; charset=utf-8"],
      ["a.toml", "text/plain; charset=utf-8"],
      ["a.ts", "text/plain; charset=utf-8"],
      ["a.tsx", "text/plain; charset=utf-8"],
      ["a.js", "text/plain; charset=utf-8"],
      ["a.jsx", "text/plain; charset=utf-8"],
      ["a.py", "text/plain; charset=utf-8"],
      ["a.go", "text/plain; charset=utf-8"],
      ["a.rs", "text/plain; charset=utf-8"],
      ["a.java", "text/plain; charset=utf-8"],
      ["a.c", "text/plain; charset=utf-8"],
      ["a.cpp", "text/plain; charset=utf-8"],
      ["a.h", "text/plain; charset=utf-8"],
      ["a.hpp", "text/plain; charset=utf-8"],
      ["a.html", "text/plain; charset=utf-8"],
      ["a.css", "text/plain; charset=utf-8"],
      ["a.sh", "text/plain; charset=utf-8"],
      ["a.sql", "text/plain; charset=utf-8"],
    ] as const;
    for (const [name, type] of allowed) {
      await writeFile(join(root, name), name.endsWith(".svg") ? "<svg></svg>" : "ok");
      expect(extensionWhitelist.has(name.slice(name.lastIndexOf(".")).toLowerCase())).toBe(true);
      expect((await resolveAgentFile(root, name)).contentType).toBe(type);
    }

    await writeFile(join(root, "secret.exe"), "exists");
    await expectCode(root, "secret.exe", "enotfound");
  });
});
