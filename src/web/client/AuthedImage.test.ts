// Authorized media loader (commit 5). The pure core is unit-tested here (the React hook/component
// are thin wrappers over it; the client test runtime has no DOM renderer).
import { test, expect, beforeEach } from "bun:test";
import { fetchAuthorizedObjectUrl, isSameOriginApiUrl } from "./AuthedImage";

class MemStore {
  private m = new Map<string, string>();
  getItem(k: string) {
    return this.m.has(k) ? this.m.get(k)! : null;
  }
  setItem(k: string, v: string) {
    this.m.set(k, v);
  }
  removeItem(k: string) {
    this.m.delete(k);
  }
}
beforeEach(() => {
  (globalThis as any).localStorage = new MemStore();
});

function blobResponse(status = 200): Response {
  return new Response(new Blob([new Uint8Array([1, 2, 3])], { type: "image/png" }), { status });
}

test("isSameOriginApiUrl gates only same-origin /api/* (relative); leaves data/blob/external alone", () => {
  expect(isSameOriginApiUrl("/api/uploads/demo/x")).toBe(true);
  expect(isSameOriginApiUrl("/api/meshes/m/agents/a/artifacts/p.png")).toBe(true);
  // not gated:
  expect(isSameOriginApiUrl("/api")).toBe(false); // not under /api/
  expect(isSameOriginApiUrl("/mesh/x/agent/y/file/z")).toBe(false); // viewer route, not bytes
  expect(isSameOriginApiUrl("data:image/png;base64,AAAA")).toBe(false);
  expect(isSameOriginApiUrl("blob:abc")).toBe(false);
  expect(isSameOriginApiUrl("https://evil.example/api/steal.png")).toBe(false); // external host
  expect(isSameOriginApiUrl(undefined)).toBe(false);
  expect(isSameOriginApiUrl("")).toBe(false);
});

test("fetchAuthorizedObjectUrl fetches with Bearer (no URL token) and returns an object URL", async () => {
  (globalThis as any).localStorage.setItem("mesh.deviceToken", "tok-img");
  const calls: Array<{ url: string; init: any }> = [];
  const fetchMock = ((url: string, init: any) => {
    calls.push({ url, init });
    return Promise.resolve(blobResponse());
  }) as any;
  const blobs: Blob[] = [];
  const make = (b: Blob) => {
    blobs.push(b);
    return "blob:fake-1";
  };
  const objectUrl = await fetchAuthorizedObjectUrl("/api/uploads/demo/x", fetchMock, make);
  expect(objectUrl).toBe("blob:fake-1");
  expect(calls[0].url).toBe("/api/uploads/demo/x");
  expect(calls[0].url).not.toContain("token="); // never a URL token
  expect(calls[0].init.headers).toEqual({ Authorization: "Bearer tok-img" });
  expect(blobs).toHaveLength(1);
});

test("fetchAuthorizedObjectUrl returns null on non-OK and on network error (alt shows, no object URL)", async () => {
  let made = 0;
  const make = () => {
    made++;
    return "blob:should-not-happen";
  };
  expect(await fetchAuthorizedObjectUrl("/api/x", (() => Promise.resolve(blobResponse(401))) as any, make)).toBeNull();
  expect(await fetchAuthorizedObjectUrl("/api/x", (() => Promise.reject(new Error("net"))) as any, make)).toBeNull();
  expect(made).toBe(0); // never created an object URL on failure
});

test("fetchAuthorizedObjectUrl fails closed on a non-/api URL: no fetch, no object URL, even with a token", async () => {
  (globalThis as any).localStorage.setItem("mesh.deviceToken", "tok-secret");
  let fetched = 0;
  let made = 0;
  const fetchMock = (() => {
    fetched++;
    return Promise.resolve(blobResponse());
  }) as any;
  const make = () => {
    made++;
    return "blob:nope";
  };
  for (const bad of ["https://external.example/steal.png", "data:image/png;base64,AAAA", "/mesh/demo/agent/dev/artifact/x.png", "blob:abc"]) {
    expect(await fetchAuthorizedObjectUrl(bad, fetchMock, make)).toBeNull();
  }
  expect(fetched).toBe(0); // the bearer token is NEVER sent off-origin / to a non-API URL
  expect(made).toBe(0);
});

test("fetchAuthorizedObjectUrl sends no Authorization when there is no token", async () => {
  const calls: Array<{ init: any }> = [];
  const fetchMock = ((_url: string, init: any) => {
    calls.push({ init });
    return Promise.resolve(blobResponse());
  }) as any;
  await fetchAuthorizedObjectUrl("/api/x", fetchMock, () => "blob:y");
  expect(calls[0].init.headers).toEqual({});
});
