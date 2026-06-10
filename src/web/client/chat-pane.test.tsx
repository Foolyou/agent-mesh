import { test, expect } from "bun:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { ChatPane } from "./ChatPane";
import { I18nContext, translate } from "./i18n";

test("ChatPane renders a compact plain-text queue box above the composer", () => {
  const html = renderToStaticMarkup(
    createElement(
      I18nContext.Provider,
      { value: { lang: "en", t: (key, vars) => translate(key, "en", vars) } },
      createElement(ChatPane, {
        items: [],
        queue: { count: 2, latestPreview: "you: **not markdown** <script>" },
        onSend: () => {},
      }),
    ),
  );

  expect(html).toContain("queued: 2");
  expect(html).toContain("you: **not markdown** &lt;script&gt;");
  expect(html).not.toContain("<strong>not markdown</strong>");
  expect(html).toContain("queue-box");
});
