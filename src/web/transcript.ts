// Pure aggregation reducer: folds raw ACP SessionUpdate objects (the inner `update`
// payload, discriminated by `sessionUpdate`) into an ordered, identity-keyed list of
// TranscriptItems. No I/O — the caller passes `now` so it stays deterministic and
// testable. The same reducer runs server-side (WebGateway) and mirrors on the client.
import type { TranscriptItem, TranscriptOp } from "./types";

let seq = 0;
function nid(now: string): string {
  return `i${now}-${seq++}`;
}

/** Best-effort text extraction from an ACP ContentBlock (or nested shapes). */
function textOf(content: any): string {
  if (content == null) return "";
  if (typeof content === "string") return content;
  const type = typeof content.type === "string" ? content.type.toLowerCase() : "";
  if (type === "image") return imageMarkdown(content);
  if (type === "resourcelink" || type === "resource_link") return resourceLinkMarkdown(content);
  if (typeof content.text === "string") return content.text;
  if (Array.isArray(content)) return content.map(textOf).join("");
  if (content.content) return textOf(content.content);
  return "";
}

function imageMarkdown(block: any): string {
  const src = linkTargetOf(block);
  if (!src) return "";
  const alt = markdownLabel(String(block.alt ?? block.name ?? ""));
  return `![${alt}](${markdownDestination(src, block.title)})`;
}

function resourceLinkMarkdown(block: any): string {
  const uri = linkTargetOf(block);
  if (!uri) return "";
  const label = markdownLabel(String(block.name ?? block.title ?? uri));
  return `[${label}](${markdownDestination(uri, block.title)})`;
}

function linkTargetOf(block: any): string {
  for (const key of ["uri", "path", "url", "src"] as const) {
    if (typeof block[key] === "string" && block[key]) return block[key];
  }
  if (typeof block.data === "string" && typeof block.mimeType === "string") {
    return `data:${block.mimeType};base64,${block.data}`;
  }
  return "";
}

function markdownLabel(value: string): string {
  return value.replace(/\\/g, "\\\\").replace(/\]/g, "\\]");
}

function markdownDestination(value: string, title?: unknown): string {
  const destination = /^[^\s()<>"']+$/.test(value) ? value : `<${value.replace(/\\/g, "\\\\").replace(/>/g, "\\>")}>`;
  if (typeof title !== "string" || !title) return destination;
  return `${destination} "${title.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
}

/** Collapse tool-call output (ToolCallContent[] and/or rawOutput) into readable text. */
function stringifyReadable(value: any): string {
  if (typeof value === "string") return value;
  try {
    return JSON.stringify(value) ?? String(value);
  } catch {
    return String(value);
  }
}

function toolResponseOf(update: any): any {
  return update?._meta?.claudeCode?.toolResponse;
}

function readableField(value: any): string | undefined {
  if (value == null) return undefined;
  if (typeof value === "string") return value || undefined;
  const text = textOf(value);
  return text || stringifyReadable(value);
}

function knownOutputFieldOf(value: any): string | undefined {
  if (value == null) return undefined;
  if (typeof value !== "object") return readableField(value);

  for (const key of ["formatted_output", "aggregated_output"] as const) {
    const out = readableField(value[key]);
    if (out) return out;
  }

  const stdout = readableField(value.stdout);
  const stderr = readableField(value.stderr);
  if (stdout || stderr) return `${stdout ?? ""}${stderr ?? ""}`;

  for (const key of ["output", "text", "content"] as const) {
    const out = readableField(value[key]);
    if (out) return out;
  }

  return undefined;
}

function outputOf(content: any, rawOutput: any, toolResponse?: any): string {
  let s = "";
  if (Array.isArray(content)) s = content.map((c: any) => textOf(c?.content ?? c)).join("");
  if (!s && rawOutput != null) {
    s = knownOutputFieldOf(rawOutput) ?? stringifyReadable(rawOutput);
  }
  if (!s && toolResponse != null) {
    s = knownOutputFieldOf(toolResponse) ?? stringifyReadable(toolResponse);
  }
  return s;
}

/** Pretty-print a tool's raw input parameters. */
function inputOf(rawInput: any): string | undefined {
  if (rawInput == null) return undefined;
  if (
    typeof rawInput === "object" &&
    !Array.isArray(rawInput) &&
    Object.keys(rawInput).length === 0
  ) {
    return undefined;
  }
  if (typeof rawInput === "object" && !Array.isArray(rawInput)) {
    const command = rawInput.command;
    const commandText = Array.isArray(command)
      ? command.map(String).join(" ")
      : typeof command === "string"
        ? command
        : undefined;
    if (commandText) {
      return typeof rawInput.cwd === "string" && rawInput.cwd
        ? `command: ${commandText}\ncwd: ${rawInput.cwd}`
        : `command: ${commandText}`;
    }
  }
  try {
    const s = typeof rawInput === "string" ? rawInput : JSON.stringify(rawInput, null, 2);
    return s || undefined;
  } catch {
    return String(rawInput);
  }
}

/** Affected file locations as "path" / "path:line" strings. */
function locationsOf(locations: any): string[] | undefined {
  if (!Array.isArray(locations) || !locations.length) return undefined;
  const out = locations
    .map((l: any) => (l?.path ? `${l.path}${l.line != null ? `:${l.line}` : ""}` : ""))
    .filter(Boolean);
  return out.length ? out : undefined;
}

function hasToolResult(update: any): boolean {
  const content = update?.content;
  return (
    (Array.isArray(content) ? content.length > 0 : content != null) ||
    update?.rawOutput != null ||
    toolResponseOf(update) != null
  );
}

function failedToolResult(update: any): boolean {
  const toolResponse = toolResponseOf(update);
  return (
    !!toolResponse &&
    typeof toolResponse === "object" &&
    (toolResponse.is_error === true || "error" in toolResponse)
  );
}

function inferredToolStatus(update: any): "completed" | "failed" | undefined {
  if (!hasToolResult(update)) return undefined;
  return failedToolResult(update) ? "failed" : "completed";
}

export function reduceTranscript(
  items: TranscriptItem[],
  update: any,
  now: string,
): { items: TranscriptItem[]; ops: TranscriptOp[] } {
  const k = update?.sessionUpdate;
  const ops: TranscriptOp[] = [];
  let next = items;

  const closeOpen = () => {
    next = next.map((it) => {
      if ((it.kind === "message" || it.kind === "thought") && !it.complete) {
        ops.push({ op: "patch", id: it.id, patch: { complete: true } });
        return { ...it, complete: true };
      }
      return it;
    });
  };
  const last = () => next[next.length - 1];

  if (k === "agent_message_chunk" || k === "agent_thought_chunk" || k === "user_message_chunk") {
    const text = textOf(update.content);
    const role: "user" | "agent" = k === "user_message_chunk" ? "user" : "agent";
    const wantThought = k === "agent_thought_chunk";
    const open = last();
    const sameOpen =
      !!open &&
      (open.kind === "message" || open.kind === "thought") &&
      !open.complete &&
      (wantThought ? open.kind === "thought" : open.kind === "message" && open.role === role);
    if (sameOpen && open) {
      const merged = { ...(open as any), text: (open as any).text + text } as TranscriptItem;
      next = [...next.slice(0, -1), merged];
      ops.push({ op: "patch", id: open.id, patch: { text: (merged as any).text } });
    } else {
      const id = nid(now);
      const item: TranscriptItem = wantThought
        ? { id, kind: "thought", text, ts: now, complete: role === "user" }
        : { id, kind: "message", role, text, ts: now, complete: role === "user", images: update.images };
      next = [...next, item];
      ops.push({ op: "upsert", item });
    }
    return { items: next, ops };
  }

  if (k === "tool_call") {
    closeOpen();
    const id = nid(now);
    const item: TranscriptItem = {
      id,
      kind: "tool_call",
      toolCallId: String(update.toolCallId),
      title: update.title ?? "tool",
      toolKind: update.kind,
      status: update.status ?? inferredToolStatus(update) ?? "pending",
      input: inputOf(update.rawInput),
      output: outputOf(update.content, update.rawOutput, toolResponseOf(update)) || undefined,
      locations: locationsOf(update.locations),
      ts: now,
      updatedTs: now,
    };
    next = [...next, item];
    ops.push({ op: "upsert", item });
    return { items: next, ops };
  }

  if (k === "tool_call_update") {
    const tcid = String(update.toolCallId);
    const idx = next.findIndex((it) => it.kind === "tool_call" && it.toolCallId === tcid);
    const patch: Partial<TranscriptItem> & Record<string, unknown> = { updatedTs: now };
    if (update.status != null) patch.status = update.status;
    else {
      const status = inferredToolStatus(update);
      if (status) patch.status = status;
    }
    if (update.title != null) patch.title = update.title;
    if (update.kind != null) patch.toolKind = update.kind;
    const inp = inputOf(update.rawInput);
    if (inp) patch.input = inp;
    const locs = locationsOf(update.locations);
    if (locs) patch.locations = locs;
    const out = outputOf(update.content, update.rawOutput, toolResponseOf(update));
    if (out) {
      const prev = idx >= 0 ? ((next[idx] as any).output as string | undefined) : undefined;
      patch.output = (prev || "") + out;
    }
    if (idx >= 0) {
      const merged = { ...(next[idx] as any), ...patch } as TranscriptItem;
      const id = next[idx].id;
      next = [...next.slice(0, idx), merged, ...next.slice(idx + 1)];
      ops.push({ op: "patch", id, patch });
    } else {
      const id = nid(now);
      const item: TranscriptItem = {
        id,
        kind: "tool_call",
        toolCallId: tcid,
        title: update.title ?? "tool",
        toolKind: update.kind,
        status: update.status ?? inferredToolStatus(update) ?? "pending",
        output: out || undefined,
        ts: now,
        updatedTs: now,
      };
      next = [...next, item];
      ops.push({ op: "upsert", item });
    }
    return { items: next, ops };
  }

  // Plan updates replace the whole plan each time. Keep a single, in-place plan card
  // (stable id) so it updates rather than stacking.
  if (k === "plan") {
    const entries = (Array.isArray(update.entries) ? update.entries : []).map((e: any) => ({
      content: String(e?.content ?? ""),
      status: String(e?.status ?? "pending"),
      priority: e?.priority,
    }));
    const idx = next.findIndex((it) => it.kind === "plan");
    if (idx >= 0) {
      const merged = { ...(next[idx] as any), entries, updatedTs: now } as TranscriptItem;
      const id = next[idx].id;
      next = [...next.slice(0, idx), merged, ...next.slice(idx + 1)];
      ops.push({ op: "patch", id, patch: { entries, updatedTs: now } as Partial<TranscriptItem> });
    } else {
      const item: TranscriptItem = { id: "plan", kind: "plan", entries, ts: now, updatedTs: now };
      next = [...next, item];
      ops.push({ op: "upsert", item });
    }
    return { items: next, ops };
  }

  // Turn boundary sentinel: caller emits { sessionUpdate: "__turn_end__" } when a
  // prompt turn resolves, so any open message/thought is sealed.
  if (k === "__turn_end__") {
    closeOpen();
    return { items: next, ops };
  }

  // Inter-agent mail (not an ACP update): the gateway folds each received mail into the
  // recipient's conversation as a distinct, sender-labeled item via this synthetic update.
  if (k === "__mail__") {
    closeOpen(); // seal any open streaming message/thought before the mail card
    const id = nid(now);
    const item: TranscriptItem = {
      id,
      kind: "mail",
      from: String(update.from),
      to: String(update.to),
      body: textOf(update.body) || String(update.body ?? ""),
      ts: now,
    };
    next = [...next, item];
    ops.push({ op: "upsert", item });
    return { items: next, ops };
  }

  // plan / available_commands_update / current_mode_update and anything unknown:
  // not part of the conversation transcript.
  return { items: next, ops: [] };
}
