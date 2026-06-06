// src/tui/app.ts
// Interactive TUI over MeshManager + an optional MasterAgent. Two contexts:
//   top:  chat with the master agent + a live mesh list
//   mesh: chat with the selected mesh's Router (primary pane; 'f' fullscreen)
// Permission escalations from a running mesh render and are resolvable by key.
import type { MeshManager } from "../mesh-manager";
import type { MasterAgent } from "../master-agent";
import type { MeshEvent } from "../acp/types";
import { LineEditor } from "./line-editor";

const C = {
  reset: "\x1b[0m", dim: "\x1b[2m", bold: "\x1b[1m",
  red: "\x1b[31m", green: "\x1b[32m", yellow: "\x1b[33m",
  blue: "\x1b[34m", cyan: "\x1b[36m", gray: "\x1b[90m",
};

interface Pending { meshName: string; requestId: string; agent: string; question: string; options: { id: string; name: string; kind?: string }[]; }

export class Tui {
  private editor = new LineEditor();
  private context: "top" | "mesh" = "top";
  private selectedMesh = 0;
  private fullscreen = false;
  private masterLog: string[] = [];          // master-agent conversation lines
  private meshChat = new Map<string, string[]>(); // per-mesh router conversation
  private activity: string[] = [];
  private pending: Pending[] = [];
  private dirty = true;
  private renderTimer?: ReturnType<typeof setInterval>;
  private unsubscribe?: () => void;
  private masterUnsub?: () => void;
  private origConsole?: { log: any; error: any; warn: any };
  private keyHandler = (d: string) => this.onKey(d);

  constructor(private manager: MeshManager, private master?: MasterAgent) {}

  start(): void {
    this.origConsole = { log: console.log, error: console.error, warn: console.warn };
    console.log = () => {}; console.error = () => {}; console.warn = () => {};

    this.unsubscribe = this.manager.on((name, e) => this.ingest(name, e));
    if (this.master) this.masterUnsub = this.master.on((u) => this.ingestMaster(u));

    process.stdout.write("\x1b[?1049h\x1b[?25l");
    if (process.stdin.isTTY) {
      process.stdin.setRawMode(true);
      process.stdin.resume();
      process.stdin.setEncoding("utf8");
      process.stdin.on("data", this.keyHandler);
    }
    this.renderTimer = setInterval(() => { if (this.dirty) { this.dirty = false; this.render(); } }, 100);
    this.render();
  }

  stop(): void {
    this.renderTimer && clearInterval(this.renderTimer);
    this.unsubscribe?.();
    this.masterUnsub?.();
    if (process.stdin.isTTY) {
      process.stdin.off("data", this.keyHandler);
      process.stdin.setRawMode(false);
    }
    process.stdout.write("\x1b[?25h\x1b[?1049l");
    if (this.origConsole) { console.log = this.origConsole.log; console.error = this.origConsole.error; console.warn = this.origConsole.warn; }
  }

  private meshNames(): string[] { return this.manager.listMeshes().map((m) => m.name); }
  private currentMesh(): string | undefined { return this.meshNames()[this.selectedMesh]; }

  private summarize(update: any): string {
    const k = update?.sessionUpdate ?? "?";
    if (k === "agent_message_chunk" || k === "agent_thought_chunk")
      return String(update?.content?.text ?? "").replace(/\s+/g, " ");
    if (k === "tool_call" || k === "tool_call_update")
      return `[tool] ${update?.title ?? ""} ${update?.status ?? ""}`;
    return k;
  }

  private ingest(name: string, e: MeshEvent): void {
    this.dirty = true;
    if (e.kind === "update") {
      const line = this.summarize(e.update);
      const log = this.meshChat.get(name) ?? [];
      log.push(`${C.dim}${e.agent}:${C.reset} ${line}`);
      if (log.length > 200) log.shift();
      this.meshChat.set(name, log);
    } else if (e.kind === "permission") {
      this.pending.push({ meshName: name, requestId: e.requestId, agent: e.agent, question: e.question, options: e.options });
    } else if (e.kind === "permission_resolved") {
      this.pending = this.pending.filter((p) => p.requestId !== e.requestId);
      this.activity.push(`[${name}] permission ${e.requestId.slice(0, 8)} -> ${e.optionId} (${e.by})`);
    } else if (e.kind === "mail") {
      this.activity.push(`[${name}] mail ${e.from} -> ${e.to}: ${e.body.slice(0, 40)}`);
    } else if (e.kind === "interrupt") {
      this.activity.push(`[${name}] interrupt ${e.from} -> ${e.target}`);
    } else if (e.kind === "log") {
      this.activity.push(`[${name}] ${e.text}`);
    }
    if (this.activity.length > 200) this.activity.shift();
  }

  private ingestMaster(update: any): void {
    const k = update?.sessionUpdate;
    if (k === "agent_message_chunk" || k === "agent_thought_chunk" || k === "tool_call" || k === "tool_call_update") {
      this.masterLog.push(`${C.dim}master:${C.reset} ${this.summarize(update)}`);
      if (this.masterLog.length > 200) this.masterLog.shift();
      this.dirty = true;
    }
  }

  private onKey(d: string): void {
    for (const ch of d) {
      // Ctrl-C always quits.
      if (ch === "\x03") { this.quit(); return; }

      // Permission resolution (digits) takes priority when one is pending for view.
      if (ch >= "1" && ch <= "9" && this.editor.value === "") {
        const p = this.visiblePending();
        const opt = p?.options[Number(ch) - 1];
        if (p && opt) { this.manager.resolvePermission(p.meshName, p.requestId, opt.id); this.dirty = true; continue; }
      }

      if (this.context === "top") this.topKey(ch);
      else this.meshKey(ch);
    }
  }

  private topKey(ch: string): void {
    if (ch === "\x1b") return;                       // esc: no-op at top
    if (ch === "\t") { this.cycleMesh(); return; }
    if (ch === "\x12") { void this.refreshDefinitions(); return; } // Ctrl-R reload
    const submitted = this.editor.handle(ch);
    this.dirty = true;
    if (submitted === "/enter") { this.enterMesh(); return; }
    if (submitted != null && submitted.length > 0) this.sendToMaster(submitted);
  }

  private meshKey(ch: string): void {
    if (ch === "\x1b") { this.context = "top"; this.fullscreen = false; this.dirty = true; return; }
    if (ch === "\x06") { this.fullscreen = !this.fullscreen; this.dirty = true; return; } // Ctrl-F
    const submitted = this.editor.handle(ch);
    this.dirty = true;
    if (submitted != null && submitted.length > 0) this.sendToRouter(submitted);
  }

  private cycleMesh(): void {
    const n = this.meshNames().length;
    if (n > 0) { this.selectedMesh = (this.selectedMesh + 1) % n; this.dirty = true; }
  }

  private enterMesh(): void {
    const name = this.currentMesh();
    if (!name) return;
    if (this.manager.listMeshes()[this.selectedMesh]?.status !== "running") {
      this.activity.push(`cannot enter "${name}": not running`);
      return;
    }
    this.context = "mesh";
    this.dirty = true;
  }

  private sendToMaster(text: string): void {
    if (!this.master) { this.masterLog.push(`${C.yellow}(no master agent configured)${C.reset}`); return; }
    this.masterLog.push(`${C.bold}you:${C.reset} ${text}`);
    if (this.masterLog.length > 200) this.masterLog.shift();
    this.master.prompt(text).catch((e) => this.masterLog.push(`${C.red}master error: ${String(e)}${C.reset}`));
  }

  private sendToRouter(text: string): void {
    const name = this.currentMesh();
    if (!name) return;
    const log = this.meshChat.get(name) ?? [];
    log.push(`${C.bold}you -> router:${C.reset} ${text}`);
    this.meshChat.set(name, log);
    this.manager.promptRouter(name, text).catch((e) => log.push(`${C.red}router error: ${String(e)}${C.reset}`));
  }

  private async refreshDefinitions(): Promise<void> {
    await this.manager.loadDefinitions().catch(() => {});
    this.dirty = true;
  }

  private visiblePending(): Pending | undefined {
    if (this.context === "mesh") {
      const name = this.currentMesh();
      return this.pending.find((p) => p.meshName === name);
    }
    return this.pending[0];
  }

  private quit(): void {
    this.stop();
    Promise.allSettled([this.manager.stopAll(), this.master?.stop()]).finally(() => process.exit(0));
  }

  private render(): void {
    const out: string[] = ["\x1b[2J\x1b[H"];
    const meshes = this.manager.listMeshes();

    if (this.context === "top") {
      out.push(`${C.bold}${C.cyan}Agent Mesh — Control${C.reset}  ${C.dim}(master agent + mesh manager)${C.reset}`);
      out.push("");
      out.push(`${C.bold}Master agent${C.reset} ${C.dim}(type an instruction, Enter to send; type "/enter" to open selected mesh)${C.reset}`);
      for (const l of this.masterLog.slice(-8)) out.push(`  ${l}`);
      out.push("");
      out.push(`${C.bold}Meshes${C.reset} ${C.dim}(Tab to select · Ctrl-R reload defs)${C.reset}`);
      if (meshes.length === 0) out.push(`  ${C.gray}(none — ask the master agent to create one)${C.reset}`);
      meshes.forEach((m, i) => {
        const sel = i === this.selectedMesh ? `${C.bold}▸${C.reset}` : " ";
        const col = m.status === "running" ? C.green : m.status === "dead" ? C.red : m.status === "starting" ? C.yellow : C.gray;
        out.push(`${sel} ${C.bold}${m.name.padEnd(16)}${C.reset} ${col}●${C.reset} ${m.status}`);
      });
    } else {
      const name = this.currentMesh() ?? "?";
      const chat = this.meshChat.get(name) ?? [];
      out.push(`${C.bold}${C.cyan}Mesh "${name}" — Router chat${C.reset}  ${C.dim}(esc back · Ctrl-F ${this.fullscreen ? "windowed" : "fullscreen"})${C.reset}`);
      out.push("");
      const lines = this.fullscreen ? chat.slice(-30) : chat.slice(-14);
      if (lines.length === 0) out.push(`  ${C.gray}(no messages yet — type to talk to the router)${C.reset}`);
      for (const l of lines) out.push(`  ${l}`);
    }

    const p = this.visiblePending();
    if (p) {
      out.push("");
      out.push(`${C.bold}${C.yellow}⚠ Permission${C.reset} [${p.meshName}] ${p.agent}: ${C.bold}${p.question}${C.reset}`);
      out.push("   " + p.options.map((o, i) => `${C.bold}${i + 1}${C.reset}) ${o.name}`).join("   "));
    }

    if (!this.fullscreen) {
      out.push("");
      out.push(`${C.bold}Activity${C.reset}`);
      for (const l of this.activity.slice(-5)) out.push(`  ${C.gray}${l}${C.reset}`);
    }

    out.push("");
    out.push(`${C.bold}> ${C.reset}${this.editor.value}${C.dim}▌${C.reset}`);
    if (this.context === "top") {
      out.push(`${C.dim}keys: Tab select mesh · Ctrl-R reload · /enter open mesh · digits decide perm · Ctrl-C quit${C.reset}`);
    } else {
      out.push(`${C.dim}keys: Esc back · Ctrl-F fullscreen · digits decide perm · Ctrl-C quit${C.reset}`);
    }

    process.stdout.write(out.join("\n"));
  }
}
