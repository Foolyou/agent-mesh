import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test, expect } from "bun:test";
import { assertSafeBucket, readUpload, sniffImage, storeUploads, uploadPath } from "./uploads";

const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0]);

test("sniffImage accepts PNG/JPEG/GIF/WebP and rejects SVG/text", () => {
  expect(sniffImage(PNG)?.mimeType).toBe("image/png");
  expect(sniffImage(new Uint8Array([0xff, 0xd8, 0xff, 0]))?.mimeType).toBe("image/jpeg");
  expect(sniffImage(new TextEncoder().encode("GIF89a"))?.mimeType).toBe("image/gif");
  expect(sniffImage(new TextEncoder().encode("RIFFxxxxWEBP"))?.mimeType).toBe("image/webp");
  expect(sniffImage(new TextEncoder().encode("<svg></svg>"))).toBeUndefined();
});

test("upload bucket and id validation prevents traversal", () => {
  expect(() => assertSafeBucket("demo")).not.toThrow();
  expect(() => assertSafeBucket("../demo")).toThrow();
  expect(() => uploadPath("/tmp/root", "demo", "../x.png")).toThrow();
});

test("storeUploads validates count, size, SVG, and writes sniffed image", async () => {
  const root = await mkdtemp(join(tmpdir(), "mesh-upload-"));
  try {
    const file = new File([PNG], "screen.whatever", { type: "image/png" });
    const stored = await storeUploads(root, "demo", [file]);
    expect(stored[0].mimeType).toBe("image/png");
    expect(stored[0].url).toContain("/api/uploads/demo/");
    const read = await readUpload(root, "demo", stored[0].id);
    expect(read.mimeType).toBe("image/png");

    await expect(storeUploads(root, "demo", Array.from({ length: 6 }, (_, i) => new File([PNG], `${i}.png`, { type: "image/png" })))).rejects.toThrow(/too many/);
    await expect(storeUploads(root, "demo", [new File([new Uint8Array(10 * 1024 * 1024 + 1)], "big.png", { type: "image/png" })])).rejects.toThrow(/too large/);
    await expect(storeUploads(root, "demo", [new File([new TextEncoder().encode("<svg></svg>")], "bad.svg", { type: "image/svg+xml" })])).rejects.toThrow(/SVG/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
