import { expect, test } from "bun:test";
import { redactPath } from "../redact";

test("redactPath shortens absolute home paths", () => {
  expect(redactPath("/home/chenan/foo")).toBe("~/foo");
  expect(redactPath("/Users/alice/projects/mesh")).toBe("~/projects/mesh");
});

test("redactPath leaves already redacted and relative paths alone", () => {
  expect(redactPath("~/already/relative")).toBe("~/already/relative");
  expect(redactPath("src/foo.ts")).toBe("src/foo.ts");
  expect(redactPath("chenan/x")).toBe("chenan/x");
});

test("redactPath handles nul and multiline input without throwing", () => {
  expect(() => redactPath("bad\0/home/chenan/foo\n/Users/alice/bar")).not.toThrow();
  expect(redactPath("bad\0/home/chenan/foo\n/Users/alice/bar")).toContain("~/foo");
  expect(redactPath("bad\0/home/chenan/foo\n/Users/alice/bar")).toContain("~/bar");
});
