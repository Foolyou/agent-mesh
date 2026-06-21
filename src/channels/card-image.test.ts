import { expect, test } from "bun:test";
import {
  createImageResolver,
  parseArtifactRef,
  imageElement,
  imageDims,
  jimpScaler,
  type RawImage,
  type ArtifactRef,
  type ImageLimits,
  type ImageScaler,
  type ScaleRequest,
} from "./card-image";
import type { ImageBoundary } from "./stream-segmenter";
import { Jimp } from "jimp";

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

function fakes(over?: { readImage?: (r: ArtifactRef) => Promise<RawImage | null>; upload?: (i: RawImage) => Promise<{ imgKey?: string; error?: string }>; viewerUrl?: (r: ArtifactRef) => string | undefined; limits?: ImageLimits; scaler?: ImageScaler }) {
  const uploads: RawImage[] = [];
  const logs: string[] = [];
  const resolver = createImageResolver({
    mesh: "m1",
    defaultAgent: "router",
    readImage: over?.readImage ?? (async () => raw()),
    upload: over?.upload ?? (async (i) => { uploads.push(i); return { imgKey: `img_${uploads.length}` }; }),
    viewerUrl: over?.viewerUrl,
    limits: over?.limits,
    scaler: over?.scaler,
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

// ── autoscale decision flow (C2): scaler wired into the resolver, exercised with a FAKE scaler ──

test("autoscale: salvageable oversize (wide PNG, aspect OK) runs the scaler and uploads the SCALED bytes", async () => {
  const scaledBytes = PNG(1500, 844); // fake scaler output, within limits
  const calls: ScaleRequest[] = [];
  const { resolver, uploads } = fakes({
    readImage: async () => raw({ bytes: PNG(2320, 1466), size: 5000 }), // width 2320 > 1500, aspect OK
    scaler: async (req) => { calls.push(req); return { bytes: scaledBytes, contentType: "image/png", width: 1500, height: 844 }; },
    limits: LIMITS,
  });
  expect((await resolver.resolve(boundary("artifact:wide.png"))).kind).toBe("image");
  expect(calls).toHaveLength(1); // scaler consulted
  expect(calls[0]).toMatchObject({ maxWidth: 1500, maxHeight: 3000, maxBytes: LIMITS.maxBytes });
  expect(uploads).toHaveLength(1);
  expect(uploads[0]!.bytes).toBe(scaledBytes); // the SCALED bytes were uploaded, not the original
});

test("autoscale: aspect too tall degrades WITHOUT consulting the scaler (no crop/reshape)", async () => {
  let called = 0;
  const { resolver, uploads } = fakes({
    readImage: async () => raw({ bytes: PNG(100, 2000) }), // h/w = 20 > 16/9
    scaler: async () => { called++; return null; },
    limits: LIMITS,
  });
  expect((await resolver.resolve(boundary("artifact:tall.png"))).kind).not.toBe("image");
  expect(called).toBe(0);
  expect(uploads).toHaveLength(0);
});

test("autoscale: an already in-limit image uploads ORIGINAL bytes without calling the scaler", async () => {
  let called = 0;
  const orig = PNG(1400, 800);
  const { resolver, uploads } = fakes({
    readImage: async () => raw({ bytes: orig }),
    scaler: async () => { called++; return null; },
    limits: LIMITS,
  });
  expect((await resolver.resolve(boundary("artifact:ok.png"))).kind).toBe("image");
  expect(called).toBe(0);
  expect(uploads[0]!.bytes).toBe(orig);
});

test("autoscale: scaler returns null (unsalvageable) degrades, no upload", async () => {
  const { resolver, uploads } = fakes({
    readImage: async () => raw({ bytes: PNG(2320, 1466) }),
    scaler: async () => null,
    viewerUrl: (r) => `https://c/${r.file}`,
    limits: LIMITS,
  });
  expect((await resolver.resolve(boundary("artifact:wide.png", "w"))).kind).toBe("link");
  expect(uploads).toHaveLength(0);
});

test("autoscale: scaler throws degrades cleanly, no upload", async () => {
  const { resolver, uploads } = fakes({
    readImage: async () => raw({ bytes: PNG(2320, 1466) }),
    scaler: async () => { throw new Error("boom"); },
    limits: LIMITS,
  });
  expect((await resolver.resolve(boundary("artifact:wide.png"))).kind).not.toBe("image");
  expect(uploads).toHaveLength(0);
});

test("autoscale: no scaler injected → oversize degrades exactly as before (no regression)", async () => {
  const { resolver, uploads } = fakes({ readImage: async () => raw({ bytes: PNG(2320, 1466) }), limits: LIMITS });
  expect((await resolver.resolve(boundary("artifact:wide.png"))).kind).not.toBe("image");
  expect(uploads).toHaveLength(0);
});

test("autoscale: scaled output still over WIDTH degrades (re-check after scaling)", async () => {
  const { resolver, uploads } = fakes({
    readImage: async () => raw({ bytes: PNG(2320, 1466) }),
    scaler: async () => ({ bytes: PNG(1600, 900), contentType: "image/png", width: 1600, height: 900 }), // still >1500w
    limits: LIMITS,
  });
  expect((await resolver.resolve(boundary("artifact:wide.png"))).kind).not.toBe("image");
  expect(uploads).toHaveLength(0);
});

test("autoscale: scaled output still over maxBytes degrades (re-check after scaling)", async () => {
  const { resolver, uploads } = fakes({
    readImage: async () => raw({ bytes: PNG(2320, 1466), size: 50 }),
    scaler: async () => ({ bytes: PNG(1500, 844), contentType: "image/png", width: 1500, height: 844 }), // dims OK, 24 bytes
    limits: { ...LIMITS, maxBytes: 10 }, // cap below the scaled output's byte length
  });
  expect((await resolver.resolve(boundary("artifact:wide.png"))).kind).not.toBe("image");
  expect(uploads).toHaveLength(0);
});

test("autoscale: unknown dims (WebP) skip autoscale and upload the original (current behavior preserved)", async () => {
  let called = 0;
  const webp = new Uint8Array([0x52, 0x49, 0x46, 0x46]); // RIFF → imageDims returns null
  const { resolver, uploads } = fakes({
    readImage: async () => raw({ bytes: webp, contentType: "image/webp", size: 1000 }),
    scaler: async () => { called++; return null; },
    limits: LIMITS,
  });
  expect((await resolver.resolve(boundary("artifact:x.webp"))).kind).toBe("image");
  expect(called).toBe(0);
  expect(uploads[0]!.bytes).toBe(webp);
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

// ── integration: the REAL jimpScaler wired into the resolver decision flow (C3 production combo) ──

test("integration: real jimpScaler scales a real oversize PNG through the resolver and uploads the SCALED, in-limit bytes", async () => {
  // a real 2320×1466 PNG (the live-failing dimension; aspect ~1.58 < 16:9 → salvageable, width > 1500)
  const big = await makeImage(2320, 1466, 255, "image/png");
  const uploaded: RawImage[] = [];
  const resolver = createImageResolver({
    mesh: "m1",
    defaultAgent: "router",
    readImage: async () => ({ bytes: big.bytes, contentType: "image/png", size: big.bytes.length, mtimeMs: 1 }),
    upload: async (i) => { uploaded.push(i); return { imgKey: "img_live" }; },
    scaler: jimpScaler(), // the REAL production scaler (not a fake)
    limits: LIMITS,
  });
  expect(await resolver.resolve(boundary("artifact:wide.png"))).toEqual({ kind: "image", imgKey: "img_live" });
  expect(uploaded).toHaveLength(1);
  const dims = imageDims(uploaded[0]!.bytes, uploaded[0]!.contentType)!;
  expect(dims.w).toBeLessThanOrEqual(LIMITS.maxWidth); // genuinely downscaled to fit
  expect(dims.h).toBeLessThanOrEqual(LIMITS.maxHeight);
  expect(uploaded[0]!.contentType).toBe("image/png"); // PNG container preserved (no JPEG conversion)
  expect(uploaded[0]!.bytes.length).toBeLessThanOrEqual(LIMITS.maxBytes);
  expect(uploaded[0]!.bytes.length).not.toBe(big.bytes.length); // not the original bytes
});

// ── jimpScaler adapter (real in-memory images; no disk fixtures) ──

/** Build a real raster image in memory via jimp. `gradient` makes a non-trivial image so a JPEG actually
 *  compresses differently per quality (for the quality-retry test); otherwise a flat color. */
async function makeImage(w: number, h: number, alpha: number, mime: "image/png" | "image/jpeg", gradient = false): Promise<{ bytes: Uint8Array; contentType: string }> {
  const img = new Jimp({ width: w, height: h });
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    const o = (y * w + x) * 4;
    img.bitmap.data[o] = gradient ? x & 255 : 200;
    img.bitmap.data[o + 1] = gradient ? y & 255 : 80;
    img.bitmap.data[o + 2] = gradient ? (x ^ y) & 255 : 40;
    img.bitmap.data[o + 3] = alpha;
  }
  const buf = mime === "image/jpeg" ? await img.getBuffer(mime, { quality: 90 }) : await img.getBuffer(mime);
  return { bytes: new Uint8Array(buf), contentType: mime };
}
const HUGE = 64 * 1024 * 1024;

test("jimpScaler: wide PNG scales proportionally to fit and preserves alpha", async () => {
  const src = await makeImage(400, 250, 128, "image/png");
  const out = await jimpScaler()({ ...src, maxWidth: 100, maxHeight: 3000, maxBytes: HUGE, maxAspect: 0 });
  expect(out).not.toBeNull();
  expect(out!.width).toBe(100); // 400 → 100
  expect(out!.height).toBe(62); // 250 * (100/400) = 62.5 → 62, aspect preserved
  expect(out!.contentType).toBe("image/png"); // same container
  const re = await Jimp.read(Buffer.from(out!.bytes)); // output is a real decodable PNG
  expect(re.bitmap.width).toBe(100);
  expect(re.bitmap.data[3]).toBe(128); // alpha channel survived the scale
});

test("jimpScaler: oversize JPEG stays JPEG and fits within bounds", async () => {
  const src = await makeImage(400, 200, 255, "image/jpeg", true);
  const out = await jimpScaler()({ ...src, maxWidth: 150, maxHeight: 3000, maxBytes: HUGE, maxAspect: 0 });
  expect(out).not.toBeNull();
  expect(out!.contentType).toBe("image/jpeg"); // JPEG stays JPEG
  expect(out!.width).toBe(150);
  expect(out!.height).toBe(75);
});

test("jimpScaler: JPEG over maxBytes triggers ONE quality retry that fits", async () => {
  const src = await makeImage(256, 256, 255, "image/jpeg", true);
  // measure this exact image's q90/q60 so the byte threshold is deterministic (gradient → q60 < q90)
  const img = await Jimp.read(Buffer.from(src.bytes));
  const q90 = (await img.getBuffer("image/jpeg", { quality: 90 })).length;
  const q60 = (await img.getBuffer("image/jpeg", { quality: 60 })).length;
  expect(q60).toBeLessThan(q90);
  // maxWidth/Height 0 → no resize; force the retry purely on bytes with a cap between q90 and q60
  const out = await jimpScaler()({ ...src, maxWidth: 0, maxHeight: 0, maxBytes: q90 - 1, maxAspect: 0 });
  expect(out).not.toBeNull();
  expect(out!.bytes.length).toBeLessThanOrEqual(q90 - 1); // retry produced smaller bytes that fit
});

test("jimpScaler: PNG still over maxBytes after scaling degrades (null, no JPEG conversion)", async () => {
  const src = await makeImage(400, 300, 255, "image/png", true);
  const out = await jimpScaler()({ ...src, maxWidth: 100, maxHeight: 100, maxBytes: 1, maxAspect: 0 }); // 1-byte cap
  expect(out).toBeNull(); // PNG is never converted to JPEG to fit
});

test("jimpScaler: undecodable bytes return null (degrade), never throw", async () => {
  const out = await jimpScaler()({ bytes: new Uint8Array([1, 2, 3, 4]), contentType: "image/png", maxWidth: 100, maxHeight: 100, maxBytes: HUGE, maxAspect: 0 });
  expect(out).toBeNull();
});

test("jimpScaler: unsupported container (webp) returns null without decoding", async () => {
  const out = await jimpScaler()({ bytes: new Uint8Array([1, 2, 3]), contentType: "image/webp", maxWidth: 100, maxHeight: 100, maxBytes: HUGE, maxAspect: 0 });
  expect(out).toBeNull();
});

// ── aspect letterbox-pad (feishu-image-aspect-pad C1) ──
const ASPECT = 16 / 9;

test("jimpScaler: aspect-too-tall PNG is letterbox-padded to ≤ maxAspect with TRANSPARENT padding", async () => {
  const src = await makeImage(390, 760, 255, "image/png"); // h/w = 1.95 > 16/9
  const out = await jimpScaler()({ ...src, maxWidth: 1500, maxHeight: 3000, maxBytes: HUGE, maxAspect: ASPECT });
  expect(out).not.toBeNull();
  expect(out!.height / out!.width).toBeLessThanOrEqual(ASPECT + 1e-9); // aspect now compliant
  expect(out!.width).toBeGreaterThan(390); // widened by horizontal padding
  expect(out!.height).toBe(760); // height unchanged (no fit-scale needed; only padded)
  expect(out!.contentType).toBe("image/png");
  const re = await Jimp.read(Buffer.from(out!.bytes));
  expect(re.bitmap.data[3]).toBe(0); // top-left corner = transparent padding
  const cx = Math.floor(re.bitmap.width / 2), cy = Math.floor(re.bitmap.height / 2);
  expect(re.bitmap.data[(cy * re.bitmap.width + cx) * 4 + 3]).toBe(255); // centered image is opaque
});

test("jimpScaler: aspect-too-tall JPEG is padded with neutral #ebedf0 and stays JPEG", async () => {
  const src = await makeImage(390, 760, 255, "image/jpeg", true);
  const out = await jimpScaler()({ ...src, maxWidth: 1500, maxHeight: 3000, maxBytes: HUGE, maxAspect: ASPECT });
  expect(out).not.toBeNull();
  expect(out!.contentType).toBe("image/jpeg"); // stays JPEG (no alpha → neutral fill)
  expect(out!.height / out!.width).toBeLessThanOrEqual(ASPECT + 1e-9);
  const re = await Jimp.read(Buffer.from(out!.bytes)); // top-left corner ≈ #ebedf0 (JPEG lossy → tolerance)
  expect(Math.abs(re.bitmap.data[0] - 0xeb)).toBeLessThanOrEqual(8);
  expect(Math.abs(re.bitmap.data[1] - 0xed)).toBeLessThanOrEqual(8);
  expect(Math.abs(re.bitmap.data[2] - 0xf0)).toBeLessThanOrEqual(8);
});

test("jimpScaler: a VERY tall image pads then re-fits so width ≤ maxWidth and aspect ≤ maxAspect", async () => {
  const src = await makeImage(390, 4000, 255, "image/png");
  const out = await jimpScaler()({ ...src, maxWidth: 1500, maxHeight: 3000, maxBytes: HUGE, maxAspect: ASPECT });
  expect(out).not.toBeNull();
  expect(out!.width).toBeLessThanOrEqual(1500);
  expect(out!.height).toBeLessThanOrEqual(3000);
  expect(out!.height / out!.width).toBeLessThanOrEqual(ASPECT + 1e-9);
});

test("jimpScaler: maxAspect 0 disables the pad (a tall image stays tall)", async () => {
  const src = await makeImage(390, 760, 255, "image/png");
  const out = await jimpScaler()({ ...src, maxWidth: 1500, maxHeight: 3000, maxBytes: HUGE, maxAspect: 0 });
  expect(out).not.toBeNull();
  expect(out!.width).toBe(390); // no padding
  expect(out!.height).toBe(760);
});

test("jimpScaler: an aspect-OK image is not padded (dims only fit-scaled)", async () => {
  const src = await makeImage(400, 250, 255, "image/png"); // h/w 0.625, well under maxAspect
  const out = await jimpScaler()({ ...src, maxWidth: 1500, maxHeight: 3000, maxBytes: HUGE, maxAspect: ASPECT });
  expect(out).not.toBeNull();
  expect(out!.width).toBe(400); // within limits + aspect OK → unchanged, no pad
  expect(out!.height).toBe(250);
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
