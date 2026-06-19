import { test, expect } from "bun:test";
import { LarkConsumer, parseInboundEvent, sdkDownloadImage, textFromContent, type FeishuWsClient, type ReceiveEvent } from "./consumer";
import { MAX_UPLOAD_BYTES } from "../web/uploads";
import type { InboundMsg } from "./types";

function event(over: Partial<ReceiveEvent> = {}): ReceiveEvent {
  return {
    event_id: "e1",
    sender: { sender_id: { open_id: "ou_me" }, sender_type: "user" },
    message: {
      message_id: "om_1",
      create_time: "1",
      chat_id: "oc_1",
      chat_type: "p2p",
      message_type: "text",
      content: JSON.stringify({ text: "hi" }),
    },
    ...over,
  } as ReceiveEvent;
}

test("parseInboundEvent maps SDK receive events to InboundMsg", () => {
  const msg = parseInboundEvent(event({
    message: {
      message_id: "om_1",
      create_time: "1",
      chat_id: "oc_1",
      chat_type: "group",
      message_type: "text",
      content: JSON.stringify({ text: "hello" }),
      mentions: [{ key: "_user_1", id: { open_id: "ou_bot" }, name: "Legion" }],
    },
  }));
  expect(msg).toEqual({
    eventId: "e1",
    chatId: "oc_1",
    chatType: "group",
    senderId: "ou_me",
    messageType: "text",
    text: "hello",
    mentions: [{ key: "_user_1", id: "ou_bot", name: "Legion" }],
    messageId: "om_1",
  } as InboundMsg);
});

test("parseInboundEvent captures message_id and an image message's image_key", () => {
  const msg = parseInboundEvent(event({
    message: {
      message_id: "om_img",
      create_time: "1",
      chat_id: "oc_1",
      chat_type: "p2p",
      message_type: "image",
      content: JSON.stringify({ image_key: "img_v3_xyz" }),
    },
  }));
  expect(msg?.messageId).toBe("om_img");
  expect(msg?.messageType).toBe("image");
  expect(msg?.imageKey).toBe("img_v3_xyz");
});

test("parseInboundEvent leaves imageKey undefined for malformed image content", () => {
  const msg = parseInboundEvent(event({
    message: { message_id: "om_x", create_time: "1", chat_id: "oc_1", chat_type: "p2p", message_type: "image", content: "not-json" },
  }));
  expect(msg?.messageId).toBe("om_x");
  expect(msg?.imageKey).toBeUndefined();
});

test("parseInboundEvent rejects malformed / incomplete events", () => {
  expect(parseInboundEvent(event({ event_id: "", uuid: "", message: { ...event().message, message_id: "" } }))).toBeUndefined();
  expect(parseInboundEvent(event({ sender: { sender_id: {}, sender_type: "user" } }))).toBeUndefined();
  expect(parseInboundEvent(event({ message: { ...event().message, chat_type: "weird" } }))).toBeUndefined();
});

test("textFromContent parses text JSON and renders mention keys as display names", () => {
  const text = textFromContent(JSON.stringify({ text: "@_user_1 do it" }), [{ key: "_user_1", name: "MeshBot", id: {} }]);
  expect(text).toBe("@MeshBot do it");
  expect(textFromContent("plain", undefined)).toBe("plain");
});

test("start wires the SDK dispatcher and stop closes the websocket", async () => {
  const got: InboundMsg[] = [];
  let closed = false;
  let started = false;
  let dispatch!: (data: ReceiveEvent) => Promise<void>;
  const ws: FeishuWsClient = {
    async start(params) {
      started = true;
      dispatch = async (data: ReceiveEvent) => {
        await (params.eventDispatcher as any).invoke({ schema: "2.0", header: { event_type: "im.message.receive_v1" }, event: data }, { needCheck: false });
      };
    },
    close() {
      closed = true;
    },
  };
  const c = new LarkConsumer({
    appId: "cli_1",
    appSecret: "secret",
    onMessage: (m) => got.push(m),
    createWsClient: () => ws,
  });
  await c.start();
  expect(started).toBe(true);
  await dispatch(event({ event_id: "e2", message: { ...event().message, content: JSON.stringify({ text: "hello" }) } }));
  expect(got.map((m) => m.eventId)).toEqual(["e2"]);
  c.stop();
  expect(closed).toBe(true);
});

test("sdkDownloadImage caps the stream at MAX_UPLOAD_BYTES and aborts before buffering it all", async () => {
  let pulledAfterCap = false;
  const half = Math.ceil(MAX_UPLOAD_BYTES / 2) + 1024;
  async function* stream() {
    yield Buffer.alloc(half);
    yield Buffer.alloc(half); // crosses MAX_UPLOAD_BYTES
    pulledAfterCap = true; // must never run: the reader aborts at the cap
    yield Buffer.alloc(8);
  }
  const client = { im: { v1: { messageResource: { get: async () => ({ getReadableStream: () => stream() }) } } } } as unknown as Parameters<typeof sdkDownloadImage>[0];
  let err: unknown;
  try {
    await sdkDownloadImage(client)({ messageId: "om", imageKey: "img_secret_KEY" });
  } catch (e) {
    err = e;
  }
  expect(err).toBeInstanceOf(Error);
  expect(String((err as Error).message)).not.toContain("img_secret_KEY"); // generic error, no key leak
  expect(pulledAfterCap).toBe(false); // stopped before reading the rest of the resource
});

test("sdkDownloadImage returns bytes for an under-cap stream", async () => {
  async function* stream() {
    yield Buffer.from([1, 2, 3]);
    yield Buffer.from([4, 5]);
  }
  const client = { im: { v1: { messageResource: { get: async () => ({ getReadableStream: () => stream() }) } } } } as unknown as Parameters<typeof sdkDownloadImage>[0];
  const out = await sdkDownloadImage(client)({ messageId: "om", imageKey: "img" });
  expect(Array.from(out.bytes)).toEqual([1, 2, 3, 4, 5]);
});
