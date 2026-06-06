// src/fixtures/echo-host.ts
// Test fixture: a fake mesh-host. Connects to MESH_SOCK, says ready, echoes
// each prompt back as a log event, and exits cleanly on stop. No real agents.
import net from "node:net";
import { LineBuffer, encodeFrame, type ParentMsg } from "../protocol";

const socket = net.connect(process.env.MESH_SOCK!);
const lb = new LineBuffer();
socket.setEncoding("utf8");
socket.on("connect", () => socket.write(encodeFrame({ t: "ready" })));
socket.on("data", (chunk: string) => {
  for (const line of lb.push(chunk)) {
    const msg = JSON.parse(line) as ParentMsg;
    if (msg.t === "prompt") {
      socket.write(encodeFrame({ t: "event", event: { kind: "log", text: `echo:${msg.text}`, ts: "t" } }));
    } else if (msg.t === "stop") {
      socket.write(encodeFrame({ t: "stopped" }));
      socket.end();
      setTimeout(() => process.exit(0), 10);
    }
  }
});
