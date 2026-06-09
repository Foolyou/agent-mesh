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
      await writeFile(join(root, name), "ok");
      expect(extensionWhitelist.has(name.slice(name.lastIndexOf(".")).toLowerCase())).toBe(true);
      expect((await resolveAgentFile(root, name)).contentType).toBe(type);
    }

    await writeFile(join(root, "secret.exe"), "exists");
    await expectCode(root, "secret.exe", "enotfound");

    // SVG is intentionally outside the whitelist: serving image/svg+xml on the
    // app origin would let embedded <script> execute (XSS). Matches the
    // precedent set by src/web/uploads.ts which also rejects SVG.
    await writeFile(join(root, "bad.svg"), "<svg></svg>");
    expect(extensionWhitelist.has(".svg")).toBe(false);
    await expectCode(root, "bad.svg", "enotfound");
  });
});

test("bare basename falls back to a bounded search inside the cwd", async () => {
  await withRoot(async (root) => {
    // file lives in a subdir, agent emits a bare basename (the realistic LLM error)
    await mkdir(join(root, "works"), { recursive: true });
    await writeFile(join(root, "works", "report.md"), "# inside works\n");
    const ok = await resolveAgentFile(root, "report.md");
    expect(ok.path).toBe(join(root, "works", "report.md"));
    expect(ok.contentType).toBe("text/markdown; charset=utf-8");
  });
});

test("fuzzy fallback respects extension whitelist and traversal/symlink/oversize gates", async () => {
  await withRoot(async (root) => {
    // a non-whitelisted file in a subdir must NOT be discovered by fallback
    await mkdir(join(root, "deep"), { recursive: true });
    await writeFile(join(root, "deep", "secret.exe"), "exists");
    await expectCode(root, "secret.exe", "enotfound");

    // a symlinked basename in a subdir must NOT be served by fallback
    await mkdir(join(root, "real"), { recursive: true });
    await writeFile(join(root, "real", "target.md"), "ok\n");
    await symlink(join(root, "real", "target.md"), join(root, "real", "alias.md"));
    await expectCode(root, "alias.md", "enotfound");

    // oversize file inside a subdir is still refused
    await mkdir(join(root, "big"), { recursive: true });
    await writeFile(join(root, "big", "huge.log"), new Uint8Array(5 * 1024 * 1024 + 1));
    await expectCode(root, "huge.log", "toobig");
  });
});

test("fuzzy fallback skips noisy dirs (.git, node_modules, dist, .worktrees) and hidden dirs", async () => {
  await withRoot(async (root) => {
    for (const noisy of [".git", "node_modules", "dist", ".worktrees", ".cache"]) {
      await mkdir(join(root, noisy), { recursive: true });
      await writeFile(join(root, noisy, "hidden.md"), "ignore me\n");
    }
    await expectCode(root, "hidden.md", "enotfound");

    // visible dir works as usual
    await mkdir(join(root, "docs"), { recursive: true });
    await writeFile(join(root, "docs", "visible.md"), "ok\n");
    const ok = await resolveAgentFile(root, "visible.md");
    expect(ok.path).toBe(join(root, "docs", "visible.md"));
  });
});

test("fuzzy fallback only triggers on bare basenames, not paths containing /", async () => {
  await withRoot(async (root) => {
    await mkdir(join(root, "actual"), { recursive: true });
    await writeFile(join(root, "actual", "note.md"), "real\n");
    // bare basename → fallback finds it
    expect((await resolveAgentFile(root, "note.md")).path).toBe(join(root, "actual", "note.md"));
    // a wrong specific path must NOT be silently corrected
    await expectCode(root, "wrong/path/note.md", "enotfound");
  });
});
