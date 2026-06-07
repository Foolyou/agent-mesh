import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test, expect } from "bun:test";
import { AcpAgentConnection } from "./client";

test("prompt constructs ACP text plus readable image blocks and skips missing files", async () => {
  const root = await mkdtemp(join(tmpdir(), "mesh-acp-image-"));
  const img = join(root, "img.png");
  await writeFile(img, new Uint8Array([1, 2, 3]));
  const sent: any[] = [];
  const c = Object.create(AcpAgentConnection.prototype) as AcpAgentConnection;
  (c as any).id = "a";
  (c as any).sessionId = "s";
  (c as any).conn = { prompt: async (p: any) => (sent.push(p), { stopReason: "end_turn" }) };
  (c as any).busy = false;
  (c as any).queue = [];
  try {
    await c.prompt("hi", [
      { id: "img.png", mimeType: "image/png", name: "img.png", path: img },
      { id: "missing.png", mimeType: "image/png", name: "missing.png", path: join(root, "missing.png") },
    ]);
    expect(sent[0].prompt).toHaveLength(2);
    expect(sent[0].prompt[0]).toEqual({ type: "text", text: "hi" });
    expect(sent[0].prompt[1]).toEqual({ type: "image", mimeType: "image/png", data: Buffer.from([1, 2, 3]).toString("base64") });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
