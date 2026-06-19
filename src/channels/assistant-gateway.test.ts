import { test, expect } from "bun:test";
import { unavailableAssistantGateway } from "./assistant-gateway";
import { meshAssistantGateway } from "../mesh-assistant";

test("unavailableAssistantGateway is never available, throws on prompt, no-op subscribe", async () => {
  const gw = unavailableAssistantGateway();
  expect(gw.available()).toBe(false);
  await expect(gw.prompt("hi")).rejects.toThrow();
  const unsub = gw.onAssistant(() => {});
  expect(typeof unsub).toBe("function");
  unsub(); // no-op, must not throw
});

test("meshAssistantGateway adapts a MeshAssistant: available() is live, prompt + subscribe delegate", async () => {
  const calls: { text: string; images: unknown }[] = [];
  const listeners: ((u: unknown) => void)[] = [];
  // duck-typed MeshAssistant slice (avoids spawning a real ACP connection)
  const fake = {
    _available: false,
    get available() {
      return this._available;
    },
    async prompt(text: string, images?: unknown) {
      calls.push({ text, images });
      return "turn-result"; // gateway must map this to void
    },
    on(listener: (u: unknown) => void) {
      listeners.push(listener);
      return () => {
        const i = listeners.indexOf(listener);
        if (i >= 0) listeners.splice(i, 1);
      };
    },
  };
  const gw = meshAssistantGateway(fake as unknown as import("../mesh-assistant").MeshAssistant);

  expect(gw.available()).toBe(false);
  fake._available = true;
  expect(gw.available()).toBe(true); // evaluated lazily — reflects live state

  const r = await gw.prompt("hello", []);
  expect(r).toBeUndefined(); // Promise<void>
  expect(calls).toEqual([{ text: "hello", images: [] }]);

  const seen: unknown[] = [];
  const unsub = gw.onAssistant((u) => seen.push(u));
  expect(listeners).toHaveLength(1);
  listeners[0]({ sessionUpdate: "agent_message_chunk", content: { text: "x" } });
  expect(seen).toHaveLength(1);
  unsub();
  expect(listeners).toHaveLength(0);
});
