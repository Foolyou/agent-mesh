// src/tui/line-editor.ts
// Minimal single-line input buffer for the TUI. Returns the submitted string on
// Enter, otherwise null. Pure and unit-testable (no terminal I/O).
export class LineEditor {
  private buf = "";
  get value(): string { return this.buf; }

  /** Feed one input character. Returns the line on Enter, else null. */
  handle(ch: string): string | null {
    if (ch === "\r" || ch === "\n") {
      const line = this.buf;
      this.buf = "";
      return line;
    }
    if (ch === "\x7f" || ch === "\b") {
      this.buf = this.buf.slice(0, -1);
      return null;
    }
    if (ch >= " ") this.buf += ch;
    return null;
  }

  clear(): void { this.buf = ""; }
}
