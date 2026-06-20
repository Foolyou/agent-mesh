import { test, expect } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import {
  ApprovalCard, Composer, AttachmentCard, VersionLine, formatVersion, AssigneeTag, initials, Button,
} from "./index";

const html = (el: React.ReactElement) => renderToStaticMarkup(el);

// ── ApprovalCard ─────────────────────────────────────────────────────────────
test("ApprovalCard: question + option buttons mapped by kind; group role", () => {
  const out = html(
    <ApprovalCard
      title="router · write file"
      question="Allow writing config.json?"
      options={[
        { id: "allow", label: "Allow", kind: "approve" },
        { id: "deny", label: "Deny", kind: "reject" },
        { id: "once", label: "Just once" },
      ]}
      onResolve={() => {}}
    />,
  );
  expect(out).toContain('role="group"');
  expect(out).toContain("router · write file");
  expect(out).toContain("Allow writing config.json?");
  expect((out.match(/<button/g) ?? []).length).toBe(3);
  expect(out).toContain("bg-accent"); // approve → primary
  expect(out).toContain("bg-danger"); // reject → danger
  expect(out).toContain("border-border-strong"); // neutral → secondary
});

test("ApprovalCard: resolved state hides options, busy disables them", () => {
  const resolved = html(
    <ApprovalCard question="q" options={[{ id: "a", label: "A", kind: "approve" }]} onResolve={() => {}} resolvedLabel="Allowed by you" />,
  );
  expect(resolved).toContain("Allowed by you");
  expect(resolved).not.toContain("<button");
  const busy = html(<ApprovalCard question="q" options={[{ id: "a", label: "A" }]} onResolve={() => {}} busy />);
  expect(busy).toContain("disabled");
  expect(busy).toContain('aria-busy="true"');
});

// ── Composer (shell) ──────────────────────────────────────────────────────────
test("Composer: framed group shell with editable slot + toolbar/actions/hint", () => {
  const out = html(
    <Composer toolbar={<Button>Attach</Button>} actions={<Button variant="primary">Send</Button>} hint="Enter to send">
      <textarea aria-label="message" />
    </Composer>,
  );
  expect(out).toContain('role="group"');
  expect(out).toContain('aria-label="Message composer"');
  expect(out).toContain("<textarea");
  expect(out).toContain("Attach");
  expect(out).toContain("Send");
  expect(out).toContain("Enter to send");
  expect(out).toContain("focus-within:outline"); // focus-within ring on the shell
});

test("Composer: disabled dims shell + sets aria-disabled", () => {
  const out = html(<Composer disabled>x</Composer>);
  expect(out).toContain('aria-disabled="true"');
  expect(out).toContain("opacity-60");
});

// ── AttachmentCard ─────────────────────────────────────────────────────────────
test("AttachmentCard: media slot wrapped in an SPA link; no AuthedImage coupling", () => {
  const out = html(<AttachmentCard name="diagram.png" caption="from router" href="/mesh/a/agent/x/artifact/diagram.png" media={<img alt="diagram.png" />} />);
  expect(out).toContain("<a"); // RouteLink wrapper
  expect(out).toContain('href="/mesh/a/agent/x/artifact/diagram.png"');
  expect(out).toContain("<img");
  expect(out).toContain("from router");
  expect(out).not.toContain("text-link"); // unstyled link wrapper
});

test("AttachmentCard: no media → paperclip + name affordance", () => {
  const out = html(<AttachmentCard name="notes.txt" />);
  expect(out).toContain("📎");
  expect(out).toContain("notes.txt");
  expect(out).toContain("bg-surface-sunken");
  expect(out).not.toContain("<a"); // no href → not a link
});

// ── VersionLine ────────────────────────────────────────────────────────────────
test("VersionLine: dual component with em-dash for unknown versions", () => {
  expect(formatVersion(undefined)).toBe("—");
  expect(formatVersion("1.2.3")).toBe("1.2.3");
  const out = html(<VersionLine primary={{ name: "codex-acp", version: "1.2.3" }} secondary={{ name: "codex" }} />);
  expect(out).toContain("codex-acp");
  expect(out).toContain("1.2.3");
  expect(out).toContain("·");
  expect(out).toContain("—"); // unknown secondary version
  expect(out).toContain("text-text-muted");
});

// ── AssigneeTag ─────────────────────────────────────────────────────────────────
test("initials: 1–2 letters from a display name", () => {
  expect(initials("Ada Lovelace")).toBe("AL");
  expect(initials("router")).toBe("R");
  expect(initials("  spaced  out  ")).toBe("SO");
  expect(initials("")).toBe("?");
});

test("AssigneeTag: initials avatar + name; iconOnly keeps an accessible label", () => {
  const out = html(<AssigneeTag name="Ada Lovelace" />);
  expect(out).toContain("AL");
  expect(out).toContain("Ada Lovelace");
  expect(out).toContain('title="Ada Lovelace"');
  const iconOnly = html(<AssigneeTag name="router" iconOnly />);
  expect(iconOnly).toContain("sr-only");
  expect(iconOnly).toContain("router");
});

// ── token discipline ────────────────────────────────────────────────────────────
test("no rendered C7 primitive emits a raw-* utility class", () => {
  const all = [
    html(<ApprovalCard question="q" options={[{ id: "a", label: "A", kind: "approve" }, { id: "b", label: "B", kind: "reject" }]} onResolve={() => {}} />),
    html(<Composer toolbar={<Button>t</Button>} actions={<Button variant="primary">s</Button>} hint="h">x</Composer>),
    html(<AttachmentCard name="f.png" caption="c" href="/x" media={<img alt="f" />} />),
    html(<VersionLine primary={{ name: "a", version: "1" }} secondary={{ name: "b" }} />),
    html(<AssigneeTag name="Ada Lovelace" />),
  ].join(" ");
  expect(/\braw-(?:slate|cool|warm|green|amber|red|blue|gray|signal-teal|ember|fleet-azure)-\d/.test(all)).toBe(false);
});
