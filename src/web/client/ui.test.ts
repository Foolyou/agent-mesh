import { test, expect } from "bun:test";
import { validateImageFile } from "./ui";

test("validateImageFile accepts supported images and rejects SVG, oversize, and excess count", () => {
  expect(validateImageFile(new File(["x"], "a.png", { type: "image/png" }), 0)).toBeUndefined();
  expect(validateImageFile(new File(["x"], "bad.svg", { type: "image/svg+xml" }), 0)).toMatch(/SVG/);
  expect(validateImageFile(new File([new Uint8Array(10 * 1024 * 1024 + 1)], "big.png", { type: "image/png" }), 0)).toMatch(/too large/);
  expect(validateImageFile(new File(["x"], "six.png", { type: "image/png" }), 5)).toMatch(/at most 5/);
  expect(validateImageFile(new File(["x"], "note.txt", { type: "text/plain" }), 0)).toMatch(/only PNG/);
});
