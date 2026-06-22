// Step 7.3 — focused SSR tests for the /bnw Mesh Assistant B (panel + fullscreen #21).
import { test, expect } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import type { ReactElement } from "react";
import { BnwAssistant } from "./assistant";
import type { GatewayState, TranscriptItem } from "../../types";
import type { Store } from "../store";
import { I18nContext, translate, type TFn } from "../i18n";

// Assistant copy flows through t(); render under an en I18nContext so assertions read English
// (the default context returns raw keys). The browser e2e covers zh + live switch.
const EN = { lang: "en" as const, t: ((k, vars) => translate(k, "en", vars)) as TFn };
const render = (el: ReactElement) => renderToStaticMarkup(<I18nContext.Provider value={EN}>{el}</I18nContext.Provider>);

const items: TranscriptItem[] = [
  { id: "u1", kind: "message", role: "user", text: "build an app mesh", ts: "", complete: true },
  { id: "a1", kind: "message", role: "agent", text: "creating mesh…", ts: "", complete: true },
  { id: "t1", kind: "tool_call", toolCallId: "c1", title: "create_mesh", status: "completed", output: "ok", ts: "", updatedTs: "" },
];
function state(working = false): GatewayState {
  return { meshes: [], assistant: { status: "ready", working, transcript: items }, perMesh: {} };
}
const STUB = { promptAssistant: async () => {}, interruptAssistant: async () => {} } as unknown as Store;

test("assistant panel: chat transcript + composer + fullscreen toggle", () => {
  const out = render(<BnwAssistant store={STUB} state={state()} full={false} />);
  expect(out).toContain('data-bnw-assistant="panel"');
  expect(out).toContain("Mesh Assistant");
  expect(out).toContain("data-bnw-assistant-transcript");
  expect(out).toContain("build an app mesh");
  expect(out).toContain("create_mesh"); // tool-call card
  expect(out).toContain('aria-label="Assistant composer"');
  expect(out).toContain('aria-label="assistant input"');
  expect(out).toContain('href="/bnw/assistant?full=1"'); // #21 fullscreen toggle
});

test("assistant fullscreen (#21): full frame", () => {
  const out = render(<BnwAssistant store={STUB} state={state()} full={true} />);
  expect(out).toContain('data-bnw-assistant="full"');
  expect(out).toContain('href="/bnw/assistant"'); // exit-fullscreen toggle (no ?full=1)
});

test("assistant: interrupt shows only while working", () => {
  expect(render(<BnwAssistant store={STUB} state={state(true)} full={false} />)).toContain('aria-label="interrupt assistant"');
  expect(render(<BnwAssistant store={STUB} state={state(false)} full={false} />).includes('aria-label="interrupt assistant"')).toBe(false);
});

test("assistant: empty transcript → start-conversation empty state", () => {
  const s: GatewayState = { meshes: [], assistant: { status: "ready", transcript: [] }, perMesh: {} };
  expect(render(<BnwAssistant store={STUB} state={s} full={false} />)).toContain("start a conversation");
});
