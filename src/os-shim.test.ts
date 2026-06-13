import { expect, test } from "bun:test";
import { createOsShimForTest, parseLsofPid, parseNetstatPid, parseSsPid } from "./os-shim";

test("linux ss output reports listener pid on port", () => {
  // Fixture shape from: ss -ltnp
  const out = `State  Recv-Q Send-Q Local Address:Port Peer Address:PortProcess
LISTEN 0      4096       127.0.0.1:10010      0.0.0.0:*    users:(("bun",pid=4242,fd=23))
`;
  expect(parseSsPid(out, 10010)).toBe(4242);
  expect(parseSsPid(out, 10011)).toBeNull();
});

test("darwin lsof output reports listener pid on port", () => {
  // Fixture shape from: lsof -nP -iTCP:10010 -sTCP:LISTEN
  const out = `COMMAND   PID USER   FD   TYPE             DEVICE SIZE/OFF NODE NAME
bun      5150 chen   32u  IPv4 0x123456789abcdef0      0t0  TCP 127.0.0.1:10010 (LISTEN)
`;
  expect(parseLsofPid(out)).toBe(5150);
  expect(parseLsofPid("")).toBeNull();
});

test("windows netstat output reports listener pid on port", () => {
  // Fixture shape from: netstat -ano
  const out = `  Proto  Local Address          Foreign Address        State           PID
  TCP    127.0.0.1:10010        0.0.0.0:0              LISTENING       6161
  TCP    [::]:10011             [::]:0                 LISTENING       7171
`;
  expect(parseNetstatPid(out, 10010)).toBe(6161);
  expect(parseNetstatPid(out, 10011)).toBe(7171);
  expect(parseNetstatPid(out, 10012)).toBeNull();
});

test("port helpers dispatch platform-specific commands", async () => {
  const calls: string[][] = [];
  const shim = createOsShimForTest({
    platform: "win32",
    spawnSync: (cmd) => {
      calls.push(cmd);
      return { stdout: "  TCP    127.0.0.1:10010        0.0.0.0:0              LISTENING       6161\n" };
    },
  });

  expect(await shim.portInUse(10010)).toBe(true);
  expect(await shim.findPidOnPort(10010)).toBe(6161);
  expect(calls).toEqual([["netstat", "-ano"], ["netstat", "-ano"]]);
});

test("linux killProcessTree walks child pids then kills leaves before parent", async () => {
  const calls: string[][] = [];
  const killed: Array<{ pid: number; signal?: NodeJS.Signals | number }> = [];
  const shim = createOsShimForTest({
    platform: "linux",
    spawnSync: (cmd) => {
      calls.push(cmd);
      if (cmd.join(" ") === "pgrep -P 10") return { stdout: "11\n12\n" };
      if (cmd.join(" ") === "pgrep -P 11") return { stdout: "13\n" };
      return { stdout: "" };
    },
    kill: (pid, signal) => killed.push({ pid, signal }),
  });

  await shim.killProcessTree(10);
  expect(calls).toEqual([["pgrep", "-P", "10"], ["pgrep", "-P", "11"], ["pgrep", "-P", "13"], ["pgrep", "-P", "12"]]);
  expect(killed.map((k) => k.pid)).toEqual([12, 13, 11, 10]);
});

test("windows killProcessTree uses taskkill tree mode", async () => {
  const calls: string[][] = [];
  const shim = createOsShimForTest({
    platform: "win32",
    spawnSync: (cmd) => {
      calls.push(cmd);
      return { stdout: "" };
    },
  });

  await shim.killProcessTree(10);
  expect(calls).toEqual([["taskkill", "/T", "/F", "/PID", "10"]]);
});
