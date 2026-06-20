import { expect, test } from "bun:test";
import { segmentStream, imageBoundaries, planOutbound, type Segment } from "./stream-segmenter";

// Convenience: full-parse (turn-commit) segments.
const seg = (s: string): Segment[] => segmentStream(s, { final: true }).segments;
const prose = (s: string): Segment => ({ kind: "prose", text: s });
const img = (ref: string, alt = ""): Segment => ({ kind: "image", ref, alt });

// ── prose / tables stay as ordinary markdown (revised scope: NO table component/parsing) ──

test("plain prose is a single prose segment", () => {
  expect(seg("hello world\nsecond line\n")).toEqual([prose("hello world\nsecond line\n")]);
});

test("a GFM pipe table stays in prose — it is NOT split into a table segment", () => {
  const t = "intro\n\n| mod | st | n |\n| --- | --- | --- |\n| a | ok | 1 |\n| b | warn | 2 |\n\nafter\n";
  const out = seg(t);
  expect(out).toEqual([prose(t)]); // whole thing, table included, is one markdown prose segment
  expect(out.every((s) => s.kind === "prose")).toBe(true);
});

// ── artifact image extraction ──

test("an artifact image on its own line becomes an image segment", () => {
  expect(seg("![diagram](artifact:flow.png)\n")).toEqual([img("artifact:flow.png", "diagram")]);
});

test("artifact://owner/ refs are preserved verbatim", () => {
  expect(seg("![x](artifact://codex-1/out.png)\n")).toEqual([img("artifact://codex-1/out.png", "x")]);
});

test("image mid-line splits prose-before / image / prose-after", () => {
  expect(seg("see ![a](artifact:a.png) and done\n")).toEqual([
    prose("see "),
    img("artifact:a.png", "a"),
    prose(" and done\n"),
  ]);
});

test("multiple images in order, with prose between", () => {
  expect(seg("p1 ![a](artifact:a.png) p2 ![b](artifact:b.png) p3\n")).toEqual([
    prose("p1 "),
    img("artifact:a.png", "a"),
    prose(" p2 "),
    img("artifact:b.png", "b"),
    prose(" p3\n"),
  ]);
});

test("a non-artifact image (http) is NOT extracted — it stays markdown prose", () => {
  expect(seg("![remote](https://x/y.png)\n")).toEqual([prose("![remote](https://x/y.png)\n")]);
});

test("whitespace-only prose runs between images are dropped (no empty markdown element)", () => {
  expect(seg("![a](artifact:a.png)\n\n![b](artifact:b.png)\n")).toEqual([
    img("artifact:a.png", "a"),
    img("artifact:b.png", "b"),
  ]);
});

// ── code guards: fenced, indented, inline — image/table-like text stays literal ──

test("fenced code block: an image token inside stays literal prose", () => {
  const s = "before\n```\n![x](artifact:foo.png)\n```\nafter\n";
  expect(seg(s)).toEqual([prose(s)]);
});

test("fenced code block: pipe-table-looking lines stay literal prose", () => {
  const s = "```\n| not | a | table |\n| --- | --- | --- |\n```\n";
  expect(seg(s)).toEqual([prose(s)]);
});

test("~~~ fence is not closed by ``` and a longer fence is not closed by a shorter one", () => {
  // ~~~ block stays open through a ``` line; the artifact token inside stays literal
  const s1 = "~~~\n![x](artifact:a.png)\n```\nstill code ![y](artifact:b.png)\n~~~\nout\n";
  expect(seg(s1)).toEqual([prose(s1)]);
  // a ```` (4) fence is not closed by ``` (3)
  const s2 = "````\n![x](artifact:a.png)\n```\nstill ![y](artifact:b.png)\n````\n";
  expect(seg(s2)).toEqual([prose(s2)]);
});

test("indented (>=4-space) code line: an image token stays literal prose", () => {
  const s = "    ![x](artifact:foo.png)\n";
  expect(seg(s)).toEqual([prose(s)]);
});

test("a tab-indented line: image token stays literal prose", () => {
  const s = "\t![x](artifact:foo.png)\n";
  expect(seg(s)).toEqual([prose(s)]);
});

test("inline code span: an image token inside the span is not extracted", () => {
  expect(seg("use `![x](artifact:foo.png)` here\n")).toEqual([prose("use `![x](artifact:foo.png)` here\n")]);
});

test("inline code span with double backticks containing a backtick is respected", () => {
  const s = "a ``code ` ![x](artifact:foo.png)`` b\n";
  expect(seg(s)).toEqual([prose(s)]);
});

test("a real image OUTSIDE a code span on the same line is still extracted", () => {
  // trailing "\n" after the image is a whitespace-only run → dropped (no empty markdown element)
  expect(seg("code `x` then ![a](artifact:a.png)\n")).toEqual([
    prose("code `x` then "),
    img("artifact:a.png", "a"),
  ]);
});

test("mixed: prose → fenced code (with pipes+token) → real image after the fence closes", () => {
  const out = seg("intro\n```\n| a | b |\n![x](artifact:in.png)\n```\nresult: ![r](artifact:out.png)\n");
  expect(out).toEqual([
    prose("intro\n```\n| a | b |\n![x](artifact:in.png)\n```\nresult: "),
    img("artifact:out.png", "r"),
  ]);
});

// ── streaming safety: open tail, half tokens, stability ──

test("the trailing partial (non-newline-terminated) line is held open, not committed", () => {
  const r = segmentStream("hello\nworld a");
  expect(r.segments).toEqual([prose("hello\n")]);
  expect(r.open).toBe("world a");
});

test("a half-typed image token is held in open during streaming, extracted at final", () => {
  const streaming = segmentStream("text ![a](artifact:a.p");
  expect(streaming.segments).toEqual([]); // nothing committed — the token may still complete
  expect(streaming.open).toBe("text ![a](artifact:a.p");
  // once complete + final, it extracts
  expect(seg("text ![a](artifact:a.png)")).toEqual([prose("text "), img("artifact:a.png", "a")]);
});

test("an image token broken by a newline (no closing paren) is literal prose, not an image", () => {
  expect(seg("![a](artifact:a.png\nmore\n")).toEqual([prose("![a](artifact:a.png\nmore\n")]);
});

test("final flush extracts a trailing image with no terminating newline", () => {
  expect(seg("done: ![a](artifact:a.png)")).toEqual([prose("done: "), img("artifact:a.png", "a")]);
});

test("committed segments are STABLE as the buffer grows (streaming prefix property)", () => {
  const full = "p1 ![a](artifact:a.png) p2\nmore prose\n![b](artifact:b.png)\ntail";
  // feed growing prefixes; every committed image segment, once present, never changes
  const seenImages: string[] = [];
  for (let i = 1; i <= full.length; i++) {
    const { segments } = segmentStream(full.slice(0, i));
    const imgs = segments.filter((s) => s.kind === "image") as Array<{ ref: string }>;
    // the committed image list only ever grows by appending — assert it's a prefix-extension
    for (let k = 0; k < seenImages.length; k++) expect(imgs[k]?.ref).toBe(seenImages[k]);
    if (imgs.length > seenImages.length) seenImages.push(...imgs.slice(seenImages.length).map((x) => x.ref));
  }
  expect(seenImages).toEqual(["artifact:a.png", "artifact:b.png"]);
});

// ── CRLF + edge cases ──

test("CRLF line endings are handled (fence close + image extraction)", () => {
  const s = "before\r\n```\r\n![x](artifact:a.png)\r\n```\r\nshow ![r](artifact:b.png)\r\n";
  expect(seg(s)).toEqual([
    prose("before\r\n```\r\n![x](artifact:a.png)\r\n```\r\nshow "),
    img("artifact:b.png", "r"),
  ]);
});

test("empty input yields no segments", () => {
  expect(seg("")).toEqual([]);
  expect(segmentStream("")).toEqual({ segments: [], open: "" });
});

// ── imageBoundaries: char ranges of committed artifact images (sender boundary detection) ──

test("imageBoundaries returns exact char ranges of committed artifact images", () => {
  const s = "see ![a](artifact:a.png) end\n";
  const bs = imageBoundaries(s, { final: true });
  expect(bs).toHaveLength(1);
  expect(s.slice(bs[0].start, bs[0].end)).toBe("![a](artifact:a.png)");
  expect(bs[0]).toMatchObject({ ref: "artifact:a.png", alt: "a" });
});

test("imageBoundaries skips images in code context, finds real ones", () => {
  const s = "```\n![x](artifact:in.png)\n```\nout ![r](artifact:out.png)\n";
  const bs = imageBoundaries(s, { final: true });
  expect(bs.map((b) => b.ref)).toEqual(["artifact:out.png"]);
});

test("imageBoundaries during streaming only counts committed (newline-terminated) images", () => {
  expect(imageBoundaries("a ![x](artifact:x.png")).toEqual([]); // no newline → not committed
  expect(imageBoundaries("a ![x](artifact:x.png)\n").map((b) => b.ref)).toEqual(["artifact:x.png"]);
});

// ── planOutbound: the streaming sender's next-step plan ──

test("planOutbound: no images → no boundary, prose showable to the end", () => {
  const full = "just prose, a | b | c table\n| - | - | - |\n";
  expect(planOutbound(full, 0)).toEqual({ proseCap: full.length });
});

test("planOutbound: an image ahead is the next boundary; prose capped at its start", () => {
  const full = "before ![a](artifact:a.png) after\n";
  const p = planOutbound(full, 0, { final: true });
  expect(p.image).toMatchObject({ ref: "artifact:a.png", alt: "a" });
  expect(p.proseCap).toBe(p.image!.start);
  expect(full.slice(0, p.proseCap)).toBe("before ");
});

test("planOutbound: from-offset skips an already-passed image, finds the next", () => {
  const full = "![a](artifact:a.png)mid![b](artifact:b.png)\n";
  const first = planOutbound(full, 0, { final: true }).image!;
  const next = planOutbound(full, first.end, { final: true }).image!;
  expect(first.ref).toBe("artifact:a.png");
  expect(next.ref).toBe("artifact:b.png");
});

test("planOutbound: a FORMING image token in the open tail caps prose before it (no premature prose)", () => {
  const full = "shown text ![half](artifact:x"; // no newline, token incomplete
  const p = planOutbound(full, 0);
  expect(p.image).toBeUndefined();
  expect(p.proseCap).toBe(full.indexOf("![")); // hold the forming token
  expect(full.slice(0, p.proseCap)).toBe("shown text ");
});

test("planOutbound: a FORMING non-artifact token (![x](http…) is NOT held — prose-only cadence preserved", () => {
  const full = "see ![logo](http://x/y."; // forming non-artifact image, no newline
  const p = planOutbound(full, 0);
  expect(p.image).toBeUndefined();
  expect(p.proseCap).toBe(full.length); // decided non-artifact → stream as prose, don't hold
});

test("planOutbound: an undecided forming token (![alt] / ![alt](artif…) IS held", () => {
  expect(planOutbound("x ![a", 0).proseCap).toBe("x ".length); // still typing alt
  expect(planOutbound("x ![a](artif", 0).proseCap).toBe("x ".length); // ref prefix consistent with artifact:
});

test("planOutbound: a `![` inside an open fenced block is NOT held (it is code, stream it)", () => {
  const full = "```\ncode ![x](artifact:x.png) more"; // open fence, no close
  const p = planOutbound(full, 0);
  expect(p.image).toBeUndefined();
  expect(p.proseCap).toBe(full.length); // inside a fence → not a forming image, stream the code
});

test("planOutbound at final flushes a trailing committed image with no newline", () => {
  const full = "done ![a](artifact:a.png)";
  const p = planOutbound(full, 0, { final: true });
  expect(p.image).toMatchObject({ ref: "artifact:a.png" });
  expect(full.slice(0, p.proseCap)).toBe("done ");
});
