// src/channels/stream-segmenter.ts
//
// Pure incremental segmenter for the Feishu rich-outbound path (design: docs/design/feishu-rich-outbound.md,
// revised C1 after the live probe). The router's prose arrives as a growing full-accumulated buffer; this
// splits it into an ordered list of segments the card sender (C2) renders as multiple card elements:
//   - prose → a Feishu `markdown` element. GFM tables, code blocks, links — EVERYTHING stays here. The
//     live probe confirmed Feishu's markdown element renders GFM pipe tables as real tables, so we do NOT
//     use the native table component and do NOT parse tables into columns/rows.
//   - image → an `artifact:<file>` / `artifact://<owner>/<file>` reference, the ONLY non-markdown element.
//
// Image tokens are extracted ONLY in normal markdown prose context. Inside a fenced code block (``` / ~~~),
// an indented (>=4-space / tab) code line, or an inline backtick span, an `![alt](artifact:...)` token (and
// any pipe-table-looking text) stays LITERAL prose — never an image segment. The code guard is applied
// before any image extraction.
//
// Streaming safety: only `\n`-terminated lines are committed; the trailing partial line is returned as
// `open` and re-evaluated next tick, so a half-typed image token is never committed as prose and then
// reclassified. Once a line is newline-committed its classification is final (an image token broken by a
// newline is, per CommonMark, literal). Pass { final: true } at turn-commit to parse the whole buffer.

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

/** Refs we extract as image elements: `artifact:<file>` or `artifact://<owner>/<file>`. */
const IMAGE_REF = /^artifact:(?:\/\/)?[^)\s]+$/;

/**
 * Split the accumulated `text` into ordered prose/image segments + an uncommitted `open` tail.
 * Pure: depends only on `text` and `opts`, so calling it each streaming tick over the growing buffer
 * yields a STABLE committed prefix (only the last prose run grows) — the property the sender relies on.
 */
export function segmentStream(text: string, opts: SegmentOptions = {}): SegmentResult {
  let body: string;
  let open: string;
  if (opts.final) {
    body = text;
    open = "";
  } else {
    const lastNl = text.lastIndexOf("\n");
    body = lastNl >= 0 ? text.slice(0, lastNl + 1) : "";
    open = lastNl >= 0 ? text.slice(lastNl + 1) : text;
  }
  return { segments: parse(body), open };
}

function parse(text: string): Segment[] {
  if (!text) return [];
  const segments: Segment[] = [];
  let prose = "";
  // Drop whitespace-only prose runs (e.g. the lone "\n" between two images) — they would render as an
  // empty markdown element; element spacing is handled by the card, not markdown blank lines.
  const flushProse = () => {
    if (prose.trim().length) segments.push({ kind: "prose", text: prose });
    prose = "";
  };
  let fenceChar: string | null = null;
  let fenceLen = 0;

  for (const line of splitLinesKeepEol(text)) {
    if (fenceChar) {
      prose += line; // verbatim inside a fenced code block
      if (isFenceClose(line, fenceChar, fenceLen)) {
        fenceChar = null;
        fenceLen = 0;
      }
      continue;
    }
    const fo = fenceOpen(line);
    if (fo) {
      prose += line;
      fenceChar = fo.char;
      fenceLen = fo.len;
      continue;
    }
    if (isIndentedCode(line)) {
      prose += line; // >=4-space / tab indent → code context: no image extraction on this line
      continue;
    }
    // normal prose line: extract complete image tokens outside inline-code spans
    for (const part of extractLine(line)) {
      if (typeof part === "string") prose += part;
      else {
        flushProse();
        segments.push(part);
      }
    }
  }
  flushProse();
  return segments;
}

/** Split into lines, each KEEPING its trailing `\n` (and `\r` for CRLF). Final line may have no eol. */
function splitLinesKeepEol(text: string): string[] {
  const out: string[] = [];
  let start = 0;
  for (let i = 0; i < text.length; i++) {
    if (text[i] === "\n") {
      out.push(text.slice(start, i + 1));
      start = i + 1;
    }
  }
  if (start < text.length) out.push(text.slice(start));
  return out;
}

/** A line that OPENS a fenced code block → { char, len }, else null. Indent must be <4 (>=4 is indented
 *  code, not a fence). A backtick fence's info string must not contain a backtick (CommonMark). */
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

/** Split a single committed prose line into literal text pieces (string) and image segments. Image tokens
 *  inside an inline backtick span stay literal; an incomplete token stays literal (the line is committed). */
function extractLine(line: string): Array<string | Segment> {
  const parts: Array<string | Segment> = [];
  let buf = "";
  let i = 0;
  while (i < line.length) {
    if (line[i] === "`") {
      // inline code span: opener of n backticks, closed by the next run of EXACTLY n backticks
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
        buf += line.slice(i, closeAt + n); // whole span literal
        i = closeAt + n;
        continue;
      }
      buf += "`".repeat(n); // unterminated span → literal backticks, keep scanning
      i += n;
      continue;
    }
    const img = imageAt(line, i);
    if (img) {
      if (buf) {
        parts.push(buf);
        buf = "";
      }
      parts.push({ kind: "image", ref: img.ref, alt: img.alt });
      i = img.end;
      continue;
    }
    buf += line[i];
    i++;
  }
  if (buf) parts.push(buf);
  return parts;
}

/** Match a complete `![alt](artifact:...)` token at position i (alt has no nested brackets), or null. */
function imageAt(line: string, i: number): { ref: string; alt: string; end: number } | null {
  if (line[i] !== "!" || line[i + 1] !== "[") return null;
  const close = line.indexOf("]", i + 2);
  if (close < 0 || line[close + 1] !== "(") return null;
  const paren = line.indexOf(")", close + 2);
  if (paren < 0) return null;
  const alt = line.slice(i + 2, close);
  if (alt.includes("[")) return null; // keep alt simple
  const ref = line.slice(close + 2, paren).trim();
  if (!IMAGE_REF.test(ref)) return null; // only artifact: refs become image elements
  return { ref, alt, end: paren + 1 };
}
