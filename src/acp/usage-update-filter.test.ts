import { expect, test } from "bun:test";
import { filterUsageUpdates } from "./client";

function streamFrom(chunks: string[]): ReadableStream<Uint8Array> {
  const enc = new TextEncoder();
  return new ReadableStream({
    start(c) {
      for (const ch of chunks) c.enqueue(enc.encode(ch));
      c.close();
    },
  });
}

async function collect(s: ReadableStream<Uint8Array>): Promise<string> {
  const dec = new TextDecoder();
  let out = "";
  const rd = s.getReader();
  for (;;) {
    const { value, done } = await rd.read();
    if (done) break;
    out += dec.decode(value, { stream: true });
  }
  return out;
}

test("filterUsageUpdates consumes usage_update frames and passes everything else through", async () => {
  const usage = JSON.stringify({ jsonrpc: "2.0", method: "session/update", params: { sessionId: "s", update: { sessionUpdate: "usage_update", used: 23, size: 100 } } });
  const msg = JSON.stringify({ jsonrpc: "2.0", method: "session/update", params: { sessionId: "s", update: { sessionUpdate: "agent_message_chunk", content: { text: "hi" } } } });
  const got: any[] = [];
  const out = await collect(filterUsageUpdates(streamFrom([usage + "\n", msg + "\n"]), (u) => got.push(u)));

  expect(got).toEqual([{ sessionUpdate: "usage_update", used: 23, size: 100 }]);
  expect(out).toContain("agent_message_chunk");
  expect(out).not.toContain("usage_update");
});

test("filterUsageUpdates reassembles a usage_update split across chunk boundaries", async () => {
  const usage = JSON.stringify({ method: "session/update", params: { sessionId: "s", update: { sessionUpdate: "usage_update", used: 1, size: 2 } } }) + "\n";
  const mid = Math.floor(usage.length / 2);
  const got: any[] = [];
  const out = await collect(filterUsageUpdates(streamFrom([usage.slice(0, mid), usage.slice(mid)]), (u) => got.push(u)));

  expect(got.length).toBe(1);
  expect(out.trim()).toBe(""); // fully consumed, nothing leaks to the library
});

test("filterUsageUpdates leaves non-JSON lines untouched", async () => {
  const got: any[] = [];
  const out = await collect(filterUsageUpdates(streamFrom(["not json\n", "{bad\n"]), (u) => got.push(u)));
  expect(got.length).toBe(0);
  expect(out).toBe("not json\n{bad\n");
});
