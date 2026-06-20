// src/channels/stream-segmenter.ts
//
// Pure incremental segmenter for the Feishu rich-outbound path (design: docs/design/feishu-rich-outbound.md,
// revised C1/C2 after the live probe). The router's prose arrives as a growing full-accumulated buffer.
//
// The live probe confirmed Feishu's markdown element renders GFM pipe tables as real tables, so the locked
// decision is scheme-A markdown: GFM tables, code blocks, links — EVERYTHING stays in prose markdown. The
// ONLY non-markdown thing we pull out is an `artifact:<file>` / `artifact://<owner>/<file>` IMAGE.
//
// C2 architecture (Opt-2, user-approved): images are CARD BOUNDARIES — `card-sender.ts` is a deep
// single-element streaming state machine, so the sender seals the current prose card at an image, sends a
// separate image/placeholder card, then continues prose on a fresh card (NO same-card multi-element
// insertion). This module is the pure boundary detector the sender drives:
//   - segmentStream(text, {final?}) → ordered prose/image segments + an uncommitted `open` tail (used by
//     the non-streaming C4 path and as the canonical model / test surface).
//   - imageBoundaries(text, {final?}) → the char ranges of complete artifact images (code-guarded).
//   - planOutbound(full, from, {final?}) → for the streaming sender: the next image boundary at/after
//     `from` and how far prose may safely be shown now (so a forming `![` token is never shown as prose
//     and then reclassified).
//
// Image tokens are detected ONLY in normal markdown prose context. Inside a fenced code block (``` / ~~~),
// an indented (>=4-space / tab) code line, or an inline backtick span, an `![alt](artifact:...)` token (and
// any pipe-table-looking text) stays LITERAL prose — never an image. Only `\n`-terminated lines are
// committed (the partial final line is held), unless { final: true } at turn-commit.

export type Segment =
  | { kind: "prose"; text: string }
  | { kind: "image"; ref: string; alt: string };

export interface SegmentResult {
  segments: Segment[];
  /** Trailing buffer not yet safe to commit (the partial final line). Empty when final. */
  open: string;
}

export interface SegmentOptions {
  /** Turn-commit: parse the entire buffer, hold nothing open (flush a trailing image/line). */
  final?: boolean;
}

/** A complete artifact image found in the buffer, with its char range [start, end). */
export interface ImageBoundary {
  start: number;
  end: number;
  ref: string;
  alt: string;
}

/** Streaming plan for the sender: the next image card boundary (if any) and how far prose is showable. */
export interface OutboundPlan {
  /** First complete artifact image at/after `from`, fully committed → a card boundary. */
  image?: ImageBoundary;
  /** Offset up to which `full.slice(from, proseCap)` is safe to show as prose right now (never inside a
   *  forming `![` token, never past `image.start`). */
  proseCap: number;
}

/** Refs we treat as image elements: `artifact:<file>` or `artifact://<owner>/<file>`. */
const IMAGE_REF = /^artifact:(?:\/\/)?[^)\s]+$/;

/** End of the committed region: through the last `\n` while streaming, or the whole buffer when final. */
function committedEnd(text: string, final?: boolean): number {
  if (final) return text.length;
  const lastNl = text.lastIndexOf("\n");
  return lastNl >= 0 ? lastNl + 1 : 0;
}

// ── public API ───────────────────────────────────────────────────────────────

/** Ordered prose/image segments over the committed region + the uncommitted `open` tail. */
export function segmentStream(text: string, opts: SegmentOptions = {}): SegmentResult {
  const end = committedEnd(text, opts.final);
  const { images } = scan(text, end);
  const segments: Segment[] = [];
  let cursor = 0;
  const pushProse = (s: string) => {
    if (s.trim().length) segments.push({ kind: "prose", text: s }); // drop whitespace-only runs
  };
  for (const im of images) {
    pushProse(text.slice(cursor, im.start));
    segments.push({ kind: "image", ref: im.ref, alt: im.alt });
    cursor = im.end;
  }
  pushProse(text.slice(cursor, end));
  return { segments, open: text.slice(end) };
}

/** The char ranges of complete artifact images in the committed region (code-guarded). */
export function imageBoundaries(text: string, opts: SegmentOptions = {}): ImageBoundary[] {
  return scan(text, committedEnd(text, opts.final)).images;
}

/** Plan the next streaming step for the card sender. */
export function planOutbound(full: string, from: number, opts: SegmentOptions = {}): OutboundPlan {
  const end = committedEnd(full, opts.final);
  const { images, fenceOpenAtEnd } = scan(full, end);
  const image = images.find((b) => b.start >= from);
  if (image) return { image, proseCap: image.start };
  // No committed image ahead. Hold prose before a FORMING *artifact* image token in the open tail
  // (prose context only — inside an open fence the tail is code, stream it). This stops a half-typed
  // artifact token from being shown as prose and then reclassified into a card next tick. A forming
  // NON-artifact token (e.g. `![x](http…`) is NOT held — it just stays prose — so a prose-only turn
  // keeps its exact pre-C2 streaming cadence.
  if (!opts.final && !fenceOpenAtEnd) {
    for (let p = full.indexOf("![", Math.max(from, end)); p >= 0; p = full.indexOf("![", p + 2)) {
      if (couldBeArtifactToken(full.slice(p))) return { proseCap: p };
    }
  }
  return { proseCap: full.length };
}

// ── core scan (offset-aware, code-guarded) ─────────────────────────────────────

/** Scan `text[0, end)` line by line, returning every complete artifact image (with absolute offsets) found
 *  in normal prose context, plus whether a fenced code block is still open at `end`. */
function scan(text: string, end: number): { images: ImageBoundary[]; fenceOpenAtEnd: boolean } {
  const images: ImageBoundary[] = [];
  let fenceChar: string | null = null;
  let fenceLen = 0;
  let pos = 0;
  while (pos < end) {
    const nl = text.indexOf("\n", pos);
    const lineEnd = nl >= 0 && nl < end ? nl + 1 : end;
    const line = text.slice(pos, lineEnd);
    if (fenceChar) {
      if (isFenceClose(line, fenceChar, fenceLen)) {
        fenceChar = null;
        fenceLen = 0;
      }
    } else {
      const fo = fenceOpen(line);
      if (fo) {
        fenceChar = fo.char;
        fenceLen = fo.len;
      } else if (!isIndentedCode(line)) {
        for (const im of lineImages(line, pos)) images.push(im);
      }
    }
    pos = lineEnd;
  }
  return { images, fenceOpenAtEnd: fenceChar !== null };
}

/** Images in a single (non-code) line, with offsets relative to `base`. Skips inline backtick spans. */
function lineImages(line: string, base: number): ImageBoundary[] {
  const out: ImageBoundary[] = [];
  let i = 0;
  while (i < line.length) {
    if (line[i] === "`") {
      let n = 0;
      while (line[i + n] === "`") n++;
      let j = i + n;
      let closeAt = -1;
      while (j < line.length) {
        if (line[j] === "`") {
          let k = 0;
          while (line[j + k] === "`") k++;
          if (k === n) {
            closeAt = j;
            break;
          }
          j += k;
        } else {
          j++;
        }
      }
      if (closeAt >= 0) {
        i = closeAt + n; // whole inline-code span is literal
        continue;
      }
      i += n; // unterminated span → literal backticks, keep scanning
      continue;
    }
    const m = imageAt(line, i);
    if (m) {
      out.push({ start: base + i, end: base + m.end, ref: m.ref, alt: m.alt });
      i = m.end;
      continue;
    }
    i++;
  }
  return out;
}

/** A line that OPENS a fenced code block → { char, len }, else null. Indent must be <4 (>=4 is indented
 *  code). A backtick fence's info string must not contain a backtick (CommonMark). */
function fenceOpen(line: string): { char: string; len: number } | null {
  const m = /^( {0,3})(`{3,}|~{3,})/.exec(line);
  if (!m) return null;
  const ch = m[2][0];
  if (ch === "`" && line.slice(m[1].length + m[2].length).includes("`")) return null;
  return { char: ch, len: m[2].length };
}

/** A line that CLOSES an open fence: same fence char, run length >= the opener, only trailing whitespace. */
function isFenceClose(line: string, char: string, len: number): boolean {
  const re = char === "`" ? /^ {0,3}(`{3,})[ \t]*\r?\n?$/ : /^ {0,3}(~{3,})[ \t]*\r?\n?$/;
  const m = re.exec(line);
  return !!m && m[1].length >= len;
}

/** A line indented >=4 spaces or by a tab → treated as code context (conservative guard, design §4.2). */
function isIndentedCode(line: string): boolean {
  return /^(?: {4}|\t)/.test(line);
}

/** Could `rest` (which begins with `![`) still become an `![alt](artifact:...)` token? Used to decide
 *  whether to HOLD prose at a forming token in the open tail. The alt/ref boundary is the FIRST `](`
 *  (the alt may itself contain `[`/`]` — Feishu renders `![a [v1]](artifact:…)` as an image, so we must
 *  hold it). Returns false once decided to be a non-artifact link/image (`![x](http…`), so prose-only
 *  streaming cadence is unaffected. Conservative while still typing the alt. */
function couldBeArtifactToken(rest: string): boolean {
  const sep = rest.indexOf("]("); // alt..ref boundary
  if (sep < 0) return true; // no `](` yet → still typing the alt → undecided
  const ref = rest.slice(sep + 2); // partial (or full) ref after `](`
  return "artifact:".startsWith(ref) || ref.startsWith("artifact:");
}

/** Match a complete `![alt](artifact:...)` token at position i, or null. The alt ends at the FIRST `](`,
 *  so the alt MAY contain `[`/`]` — Feishu renders `![a [v1]](artifact:…)` as an image (live-verified),
 *  so leaving it in prose poisons the card ("invalid image keys"); we must extract it. */
function imageAt(line: string, i: number): { ref: string; alt: string; end: number } | null {
  if (line[i] !== "!" || line[i + 1] !== "[") return null;
  const closeBracket = line.indexOf("](", i + 2); // alt ends at the `]` immediately before `(`
  if (closeBracket < 0) return null;
  const paren = line.indexOf(")", closeBracket + 2);
  if (paren < 0) return null;
  const alt = line.slice(i + 2, closeBracket); // may contain [ ]
  const ref = line.slice(closeBracket + 2, paren).trim();
  if (!IMAGE_REF.test(ref)) return null; // only artifact: refs become image elements
  return { ref, alt, end: paren + 1 };
}
