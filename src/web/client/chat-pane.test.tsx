import { test, expect } from "bun:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { ChatPane, isRemovableQueueItem, queueNavState, queuePreviewText, queueSourceLabel } from "./ChatPane";
import { I18nContext, translate } from "./i18n";

test("ChatPane renders a compact plain-text queue box above the composer", () => {
  const html = renderToStaticMarkup(
    createElement(
      I18nContext.Provider,
      { value: { lang: "en", t: (key, vars) => translate(key, "en", vars) } },
      createElement(ChatPane, {
        items: [],
        queue: {
          count: 2,
          latestPreview: "review: **not markdown** <script>",
          items: [
            { id: "q1", source: "operator", from: "operator", to: "codex-1", preview: "you: older", ts: "T1" },
            { id: "q2", source: "mail", from: "review", to: "codex-1", preview: "review: **not markdown** <script>", ts: "T2" },
          ],
        },
        onSend: () => {},
      }),
    ),
  );

  expect(html).toContain("queued: 2/2");
  expect(html).toContain("mail · review");
  expect(html).toContain("**not markdown** &lt;script&gt;");
  expect(html).not.toContain("review: **not markdown**");
  expect(html).not.toContain("<strong>not markdown</strong>");
  expect(html).toContain("queue-box");
  expect(html).toContain("queue-nav");
  expect(html).toContain("tabindex=\"0\"");
  expect(html).toContain("aria-label=\"queued messages, 2\"");
  expect(html).toContain("disabled=\"\"");
});

test("ChatPane renders the current queue position within the total count", () => {
  const html = renderToStaticMarkup(
    createElement(
      I18nContext.Provider,
      { value: { lang: "zh", t: (key, vars) => translate(key, "zh", vars) } },
      createElement(ChatPane, {
        items: [],
        queue: {
          count: 3,
          latestId: "q1",
          latestPreview: "you: first",
          items: [
            { id: "q1", source: "operator", from: "operator", to: "codex-1", preview: "you: first", ts: "T1" },
            { id: "q2", source: "mail", from: "review", to: "codex-1", preview: "review: second", ts: "T2" },
            { id: "q3", source: "mail", from: "consultant", to: "codex-1", preview: "consultant: third", ts: "T3" },
          ],
        },
        onSend: () => {},
      }),
    ),
  );

  expect(html).toContain("队列: 1/3");
});

test("queue navigation defaults to latest and clamps at boundaries", () => {
  const items = [
    { id: "q1", source: "operator" as const, from: "operator" as const, to: "codex-1", preview: "you: first", ts: "T1" },
    { id: "q2", source: "mail" as const, from: "review", to: "codex-1", preview: "review: second", ts: "T2" },
    { id: "q3", source: "operator" as const, from: "operator" as const, to: "codex-1", preview: "you: third", ts: "T3" },
  ];

  expect(queueNavState(items)).toMatchObject({ item: items[2], index: 2, canPrev: true, canNext: false });
  expect(queueNavState(items.slice(0, 2))).toMatchObject({ item: items[1], index: 1, canPrev: true, canNext: false });
  expect(queueNavState(items.slice(0, 3))).toMatchObject({ item: items[2], index: 2, canPrev: true, canNext: false });
  expect(queueNavState(items, undefined, undefined, "q1")).toMatchObject({ item: items[0], index: 0, canPrev: false, canNext: true });
  expect(queueNavState(items, "q2")).toMatchObject({ item: items[1], index: 1, canPrev: true, canNext: true });
  expect(queueNavState(items, "missing")).toMatchObject({ item: items[2], index: 2, canPrev: true, canNext: false });
  expect(queueNavState(items.slice(1), "q1", 0)).toMatchObject({ item: items[1], index: 0, canPrev: false, canNext: true });
  expect(queueNavState(items.slice(0, 2), "q3", 2)).toMatchObject({ item: items[1], index: 1, canPrev: true, canNext: false });
});

test("queue source labels distinguish mailbox and user messages", () => {
  expect(queueSourceLabel({ id: "q1", source: "operator", from: "operator", to: "a", preview: "p", ts: "T" })).toBe("you");
  expect(queueSourceLabel({ id: "q2", source: "mail", from: "review", to: "a", preview: "p", ts: "T" })).toBe("mail · review");
  expect(queueSourceLabel({ id: "q3", source: "steer", from: "lead", to: "a", preview: "p", ts: "T" })).toBe("steer · lead");
});

test("queue preview removes the repeated source prefix shown by the badge", () => {
  expect(queuePreviewText({ id: "q1", source: "operator", from: "operator", to: "a", preview: "you: cancel shortcuts", ts: "T" })).toBe("cancel shortcuts");
  expect(queuePreviewText({ id: "q2", source: "mail", from: "review", to: "a", preview: "mail: review this", ts: "T" })).toBe("review this");
  expect(queuePreviewText({ id: "q3", source: "steer", from: "lead", to: "a", preview: "steer: urgent", ts: "T" })).toBe("urgent");
  expect(queuePreviewText({ id: "q4", source: "mail", from: "review", to: "a", preview: "review: please check", ts: "T" })).toBe("please check");
  expect(queuePreviewText({ id: "q5", source: "operator", from: "operator", to: "a", preview: "plain text", ts: "T" })).toBe("plain text");
});

test("ChatPane renders a remove button only for user queued messages", () => {
  const userHtml = renderToStaticMarkup(
    createElement(
      I18nContext.Provider,
      { value: { lang: "en", t: (key, vars) => translate(key, "en", vars) } },
      createElement(ChatPane, {
        items: [],
        queue: {
          count: 1,
          latestId: "q1",
          latestPreview: "you: remove me",
          items: [{ id: "q1", source: "operator", from: "operator", to: "codex-1", preview: "you: remove me", ts: "T1" }],
        },
        onSend: () => {},
        onRemoveQueued: () => {},
      }),
    ),
  );
  expect(userHtml).toContain("aria-label=\"remove queued message\"");

  const mailHtml = renderToStaticMarkup(
    createElement(
      I18nContext.Provider,
      { value: { lang: "en", t: (key, vars) => translate(key, "en", vars) } },
      createElement(ChatPane, {
        items: [],
        queue: {
          count: 1,
          latestId: "q1",
          latestPreview: "review: keep me",
          items: [{ id: "q1", source: "mail", from: "review", to: "codex-1", preview: "review: keep me", ts: "T1" }],
        },
        onSend: () => {},
        onRemoveQueued: () => {},
      }),
    ),
  );
  expect(mailHtml).not.toContain("aria-label=\"remove queued message\"");
});

test("queue removal eligibility treats operator steer as user and mail-like items as protected", () => {
  expect(isRemovableQueueItem({ id: "q1", source: "operator", from: "operator", to: "a", preview: "p", ts: "T" })).toBe(true);
  expect(isRemovableQueueItem({ id: "q2", source: "steer", from: "operator", to: "a", preview: "p", ts: "T" })).toBe(true);
  expect(isRemovableQueueItem({ id: "q3", source: "mail", from: "review", to: "a", preview: "p", ts: "T" })).toBe(false);
  expect(isRemovableQueueItem({ id: "q4", source: "steer", from: "lead", to: "a", preview: "p", ts: "T" })).toBe(false);
  expect(isRemovableQueueItem({ id: "__latest__", source: "operator", from: "operator", preview: "p", ts: "T" })).toBe(false);
});
