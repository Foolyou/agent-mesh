import { expect, test } from "bun:test";
import {
  createImageResolver,
  parseArtifactRef,
  imageElement,
  imageDims,
  type RawImage,
  type ArtifactRef,
  type ImageLimits,
} from "./card-image";
import type { ImageBoundary } from "./stream-segmenter";

const boundary = (ref: string, alt = "pic"): ImageBoundary => ({ start: 0, end: 0, ref, alt });
const PNG = (w: number, h: number): Uint8Array => {
  const b = new Uint8Array(24);
  b[0] = 0x89; b[1] = 0x50; // PNG sig (enough for the sniffers used here)
  const dv = new DataView(b.buffer);
  dv.setUint32(16, w);
  dv.setUint32(20, h);
  return b;
};
const raw = (over: Partial<RawImage> = {}): RawImage => ({ bytes: PNG(800, 600), contentType: "image/png", size: 1234, mtimeMs: 1000, ...over });

// ── parseArtifactRef ──

test("parseArtifactRef: bare artifact:<file> resolves to the default (router) agent in the current mesh", () => {
  expect(parseArtifactRef("artifact:flow.png", { mesh: "m1", defaultAgent: "router" })).toEqual({ mesh: "m1", owner: "router", file: "flow.png" });
});

test("parseArtifactRef: artifact://owner/file uses that owner in the current mesh (never a mesh from the ref)", () => {
  expect(parseArtifactRef("artifact://codex-1/sub/out.png", { mesh: "m1", defaultAgent: "router" })).toEqual({ mesh: "m1", owner: "codex-1", file: "sub/out.png" });
});

test("parseArtifactRef: rejects traversal / empty / non-artifact refs", () => {
  const ctx = { mesh: "m1", defaultAgent: "r" };
  expect(parseArtifactRef("artifact://../x/f.png", ctx)).toBeNull();
  expect(parseArtifactRef("artifact:../secret", ctx)).toBeNull();
  expect(parseArtifactRef("artifact://owner/", ctx)).toBeNull();
  expect(parseArtifactRef("http://x/y.png", ctx)).toBeNull();
});

// ── resolve: upload, cache, degrade ──

function fakes(over?: { readImage?: (r: ArtifactRef) => Promise<RawImage | null>; upload?: (i: RawImage) => Promise<{ imgKey?: string; error?: string }>; viewerUrl?: (r: ArtifactRef) => string | undefined; limits?: ImageLimits }) {
  const uploads: RawImage[] = [];
  const logs: string[] = [];
  const resolver = createImageResolver({
    mesh: "m1",
    defaultAgent: "router",
    readImage: over?.readImage ?? (async () => raw()),
    upload: over?.upload ?? (async (i) => { uploads.push(i); return { imgKey: `img_${uploads.length}` }; }),
    viewerUrl: over?.viewerUrl,
    limits: over?.limits,
    log: (m) => logs.push(m),
  });
  return { resolver, uploads, logs };
}

test("resolve: a readable in-limit image uploads once and returns its image_key", async () => {
  const { resolver, uploads } = fakes();
  expect(await resolver.resolve(boundary("artifact:a.png"))).toEqual({ kind: "image", imgKey: "img_1" });
  expect(uploads).toHaveLength(1);
});

test("cache HIT: same (mesh,owner,file,size,mtime) does NOT re-upload", async () => {
  const { resolver, uploads } = fakes();
  await resolver.resolve(boundary("artifact:a.png"));
  const second = await resolver.resolve(boundary("artifact:a.png"));
  expect(second).toEqual({ kind: "image", imgKey: "img_1" });
  expect(uploads).toHaveLength(1); // served from cache
});

test("cache MISS on changed mtime or size re-uploads (content changed)", async () => {
  let r = raw({ mtimeMs: 1000 });
  const { resolver, uploads } = fakes({ readImage: async () => r });
  await resolver.resolve(boundary("artifact:a.png"));
  r = raw({ mtimeMs: 2000 }); // file changed
  await resolver.resolve(boundary("artifact:a.png"));
  r = raw({ mtimeMs: 2000, size: 9999 }); // size changed
  await resolver.resolve(boundary("artifact:a.png"));
  expect(uploads).toHaveLength(3);
});

test("missing file degrades (no upload)", async () => {
  const { resolver, uploads } = fakes({ readImage: async () => null });
  const out = await resolver.resolve(boundary("artifact:gone.png", "diagram"));
  expect(out).toEqual({ kind: "text", markdown: "🖼 diagram" }); // no viewerUrl → text
  expect(uploads).toHaveLength(0);
});

const LIMITS = { maxBytes: 10 * 1024 * 1024, maxAspect: 16 / 9, maxWidth: 1500, maxHeight: 3000 };

test("over-byte-limit degrades to link (viewerUrl present) WITHOUT uploading", async () => {
  const { resolver, uploads } = fakes({
    readImage: async () => raw({ size: 20 * 1024 * 1024 }),
    viewerUrl: (r) => `https://console/mesh/${r.mesh}/agent/${r.owner}/artifact/${r.file}`,
    limits: LIMITS,
  });
  const out = await resolver.resolve(boundary("artifact:big.png", "huge"));
  expect(out.kind).toBe("link");
  if (out.kind === "link") expect(out.markdown).toBe("[huge](https://console/mesh/m1/agent/router/artifact/big.png)");
  expect(uploads).toHaveLength(0);
});

test("aspect ratio out of range (very tall) degrades without uploading", async () => {
  const { resolver, uploads } = fakes({ readImage: async () => raw({ bytes: PNG(100, 2000) }), limits: LIMITS }); // h/w=20 > 16/9
  expect((await resolver.resolve(boundary("artifact:tall.png"))).kind).not.toBe("image");
  expect(uploads).toHaveLength(0);
});

test("width > 1500 degrades without uploading", async () => {
  const { resolver, uploads } = fakes({ readImage: async () => raw({ bytes: PNG(1600, 900) }), limits: LIMITS });
  expect((await resolver.resolve(boundary("artifact:wide.png"))).kind).not.toBe("image");
  expect(uploads).toHaveLength(0);
});

test("height > 3000 degrades without uploading", async () => {
  const { resolver, uploads } = fakes({ readImage: async () => raw({ bytes: PNG(1000, 3200) }), limits: LIMITS });
  expect((await resolver.resolve(boundary("artifact:long.png"))).kind).not.toBe("image");
  expect(uploads).toHaveLength(0);
});

test("an image within all bounds (≤1500w, ≤3000h, ≤16:9, ≤10MB) uploads", async () => {
  const { resolver, uploads } = fakes({ readImage: async () => raw({ bytes: PNG(1500, 800) }), limits: LIMITS });
  expect((await resolver.resolve(boundary("artifact:ok.png"))).kind).toBe("image");
  expect(uploads).toHaveLength(1);
});

test("upload failure degrades to link/text and never throws", async () => {
  const { resolver } = fakes({ upload: async () => ({ error: "feishu 1001" }), viewerUrl: () => "https://c/x" });
  expect((await resolver.resolve(boundary("artifact:a.png", "p"))).kind).toBe("link");
  const { resolver: r2 } = fakes({ upload: async () => { throw new Error("boom"); } });
  expect((await r2.resolve(boundary("artifact:a.png", "p"))).kind).toBe("text");
});

test("zero-leak: no ref/owner/file/secret in logs even when ref, read error, and upload error carry markers", async () => {
  const SECRET = "S3CRET-marker";
  const logs: string[] = [];
  // ref, the thrown read error, and the upload error string all contain the secret marker
  // (a) read throws with a secret in the message; (b) read OK but upload returns a secret error string
  let mode: "throw" | "uploadfail" = "throw";
  const resolver = createImageResolver({
    mesh: "m1",
    defaultAgent: "router",
    readImage: async () => {
      if (mode === "throw") throw new Error(`read /etc/${SECRET}/x`);
      return raw();
    },
    upload: async () => ({ error: SECRET }),
    log: (m) => logs.push(m),
  });
  await resolver.resolve(boundary(`artifact://owner-${SECRET}/dir/${SECRET}.png`, "a"));
  mode = "uploadfail";
  await resolver.resolve(boundary(`artifact:${SECRET}.png`, "a"));
  const blob = logs.join("\n");
  expect(blob).not.toContain(SECRET); // no owner/file/path/SDK-error text from read OR upload
  expect(blob).not.toContain("artifact:"); // no raw ref token
  expect(blob).not.toContain("/etc/"); // no path from the thrown read error
});

test("zero-leak: a non-image degrade markdown carries only alt + console URL, not the raw `artifact:` ref", async () => {
  const { resolver } = fakes({ upload: async () => ({ error: "x" }), viewerUrl: (r) => `https://c/mesh/${r.mesh}/agent/${r.owner}/artifact/${r.file}` });
  const out = await resolver.resolve(boundary("artifact://codex-1/diagram.png", "alt text"));
  // the URL contains the file path BY DESIGN (the console viewer route); the raw `artifact:` token does not
  if (out.kind === "link") {
    expect(out.markdown).toContain("https://c/mesh/m1/agent/codex-1/artifact/diagram.png");
    expect(out.markdown).not.toContain("artifact:");
  }
});

// ── imageElement + dims ──

test("imageElement builds a Feishu img element with img_key + alt (no raw ref)", () => {
  expect(imageElement("img0", "img_abc", "a diagram")).toEqual({
    tag: "img", element_id: "img0", img_key: "img_abc", alt: { tag: "plain_text", content: "a diagram" },
  });
});

test("imageDims reads PNG / GIF / JPEG sizes", () => {
  expect(imageDims(PNG(640, 480), "image/png")).toEqual({ w: 640, h: 480 });
  const gif = new Uint8Array(10);
  gif[0] = 0x47; gif[1] = 0x49; gif[6] = 0x20; gif[7] = 0x01; gif[8] = 0x40; gif[9] = 0x00; // 288x64
  expect(imageDims(gif, "image/gif")).toEqual({ w: 288, h: 64 });
  // minimal JPEG: SOI then SOF0 with 16x32 (trailing pad bytes for the reader's bounds check)
  const jpg = new Uint8Array([0xff, 0xd8, 0xff, 0xc0, 0x00, 0x11, 0x08, 0x00, 0x20, 0x00, 0x10, 0x03, 0x00]);
  expect(imageDims(jpg, "image/jpeg")).toEqual({ w: 16, h: 32 });
});
