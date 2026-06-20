import { expect, test } from "bun:test";
import { segmentStream, type Segment } from "./stream-segmenter";

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
