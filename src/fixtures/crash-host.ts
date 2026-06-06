// src/fixtures/crash-host.ts
// Test fixture: a mesh-host that connects, signals ready, then exits on its own
// (simulating a crash) so the parent's onExit/cleanup path can be exercised.
import net from "node:net";
import { encodeFrame } from "../protocol";

const socket = net.connect(process.env.MESH_SOCK!);
socket.on("connect", () => {
  socket.write(encodeFrame({ t: "ready" }));
  setTimeout(() => process.exit(1), 100);
});
