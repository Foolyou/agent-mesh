import { homedir } from "node:os";

export function redactPath(input: string): string {
  let out = String(input);
  const home = homedir();
  if (home) out = out.replace(new RegExp(escapeRegExp(home) + "(?=/|$)", "g"), "~");
  out = out.replace(/\/home\/[^/\s\0]+(?=\/|$)/g, "~");
  out = out.replace(/\/Users\/[^/\s\0]+(?=\/|$)/g, "~");
  return out;
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
