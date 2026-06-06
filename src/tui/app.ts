// Read-only Bun TUI for the Agent Mesh control plane. Renders three views
// (control plane / mesh / selected-agent internals) from the control-plane
// event bus, and lets a human resolve pending permission requests by keypress.
import type { ControlPlane } from "../control-plane";
import type { AgentId, MeshEvent } from "../acp/types";

const C = {
  reset: "\x1b[0m",
  dim: "\x1b[2m",
  bold: "\x1b[1m",
  red: "\x1b[31m",
  green: "\x1b[32m",
  yellow: "\x1b[33m",
  blue: "\x1b[34m",
  cyan: "\x1b[36m",
  gray: "\x1b[90m",
};

interface AgentView {
  status: string;
  updates: number;
  mailIn: number;
  mailOut: number;
  last: string;
  recent: string[]; // ring buffer of event summaries
}

interface PendingView {
  requestId: string;
  agent: AgentId;
  question: string;
  options: { id: string; name: string; kind?: string }[];
}

export class Tui {
  private views = new Map<AgentId, AgentView>();
  private pending: PendingView[] = [];
  private logs: string[] = [];
  private selected = 0;
  private order: AgentId[];
  private dirty = true;
  private renderTimer?: ReturnType<typeof setInterval>;
  private unsubscribe?: () => void;
  private origConsole?: { log: any; error: any; warn: any };

  constructor(private cp: ControlPlane, private onDemo?: () => void) {
    this.order = cp.mesh.agents.map((a) => a.id);
    for (const a of cp.mesh.agents) {
      this.views.set(a.id, { status: "—", updates: 0, mailIn: 0, mailOut: 0, last: "", recent: [] });
    }
  }

  start(): void {
    // Silence the ACP lib's stray console noise so it can't corrupt the screen.
    this.origConsole = { log: console.log, error: console.error, warn: console.warn };
    console.log = () => {};
    console.error = () => {};
    console.warn = () => {};

    this.unsubscribe = this.cp.on((e) => this.ingest(e));

    process.stdout.write("\x1b[?1049h\x1b[?25l"); // alt screen, hide cursor
    if (process.stdin.isTTY) {
      process.stdin.setRawMode(true);
      process.stdin.resume();
      process.stdin.setEncoding("utf8");
      process.stdin.on("data", (d: string) => this.onKey(d));
    }
    this.renderTimer = setInterval(() => {
      if (this.dirty) {
        this.dirty = false;
        this.render();
      }
    }, 100);
    this.render();
  }

  stop(): void {
    this.renderTimer && clearInterval(this.renderTimer);
    this.unsubscribe?.();
    if (process.stdin.isTTY) process.stdin.setRawMode(false);
    process.stdout.write("\x1b[?25h\x1b[?1049l"); // show cursor, leave alt screen
    if (this.origConsole) {
      console.log = this.origConsole.log;
      console.error = this.origConsole.error;
      console.warn = this.origConsole.warn;
    }
  }

  private onKey(d: string): void {
    for (const ch of d) {
      if (ch === "q" || ch === "\x03") {
        this.stop();
        this.cp.stop().finally(() => process.exit(0));
        return;
      }
      if (ch === "\t") {
        this.selected = (this.selected + 1) % this.order.length;
        this.dirty = true;
      } else if (ch === "d" && this.onDemo) {
        this.logs.push("demo: running mail → permission → interrupt sequence");
        this.onDemo();
        this.dirty = true;
      } else if (ch >= "1" && ch <= "9") {
        const idx = Number(ch) - 1;
        const p = this.pending[0];
        if (p && p.options[idx]) {
          this.cp.resolveDecision(p.requestId, p.options[idx]!.id, "human");
        }
      }
    }
  }

  private summarize(update: any): string {
    const k = update?.sessionUpdate ?? "?";
    if (k === "agent_message_chunk" || k === "agent_thought_chunk") {
      return `${k}: ${String(update?.content?.text ?? "").replace(/\s+/g, " ").slice(0, 60)}`;
    }
    if (k === "tool_call" || k === "tool_call_update") {
      return `${k}: ${update?.title ?? update?._meta?.claudeCode?.toolName ?? ""} [${update?.status ?? ""}]`;
    }
    return k;
  }

  private ingest(e: MeshEvent): void {
    this.dirty = true;
    if (e.kind === "agent_status") {
      const v = this.views.get(e.agent);
      if (v) v.status = e.status + (e.detail ? ` (${e.detail})` : "");
    } else if (e.kind === "update") {
      const v = this.views.get(e.agent);
      if (v) {
        v.updates++;
        const s = this.summarize(e.update);
        v.last = s;
        v.recent.push(s);
        if (v.recent.length > 100) v.recent.shift();
      }
    } else if (e.kind === "mail") {
      this.views.get(e.from) && (this.views.get(e.from)!.mailOut++);
      this.views.get(e.to) && (this.views.get(e.to)!.mailIn++);
      this.logs.push(`mail ${e.from} → ${e.to}: ${e.body.slice(0, 50)}`);
    } else if (e.kind === "permission") {
      this.pending.push({ requestId: e.requestId, agent: e.agent, question: e.question, options: e.options });
    } else if (e.kind === "permission_resolved") {
      this.pending = this.pending.filter((p) => p.requestId !== e.requestId);
      this.logs.push(`permission ${e.requestId.slice(0, 8)} → ${e.optionId} (${e.by})`);
    } else if (e.kind === "interrupt") {
      this.logs.push(`interrupt ${e.from} → ${e.target}${e.reason ? ` (${e.reason})` : ""}`);
    } else if (e.kind === "log") {
      this.logs.push(e.text);
    }
    if (this.logs.length > 200) this.logs.shift();
  }

  private statusColor(s: string): string {
    if (s.startsWith("ready")) return C.green;
    if (s.startsWith("dead")) return C.red;
    if (s.startsWith("spawning")) return C.yellow;
    return C.gray;
  }

  private render(): void {
    const out: string[] = [];
    out.push("\x1b[2J\x1b[H");
    const mesh = this.cp.mesh;
    let port = "?";
    try {
      port = String(this.cp.mcpServer.port);
    } catch {}

    out.push(`${C.bold}${C.cyan}Agent Mesh Control Plane${C.reset}  ${C.dim}(deterministic; no master agent)${C.reset}`);
    out.push(
      `Control plane: mesh=${C.bold}${mesh.name}${C.reset}  MCP=http://127.0.0.1:${port}  agents=${mesh.agents.length}  pending=${this.pending.length}`,
    );
    out.push("");
    out.push(`${C.bold}Mesh "${mesh.name}"${C.reset}  ${C.dim}router: ${mesh.router.id}${C.reset}`);
    this.order.forEach((id, i) => {
      const a = mesh.agent(id)!;
      const v = this.views.get(id)!;
      const sel = i === this.selected ? `${C.bold}▸${C.reset}` : " ";
      const sc = this.statusColor(v.status);
      const roleTag = a.role === "router" ? `${C.blue}router${C.reset}` : "member";
      out.push(
        `${sel} ${C.bold}${id.padEnd(12)}${C.reset} ${C.dim}[${a.harness}]${C.reset} ${roleTag.padEnd(6)} ${sc}●${C.reset} ${v.status.padEnd(10)} ` +
          `${C.gray}mail↑${v.mailOut} ↓${v.mailIn} upd:${v.updates}${C.reset}  ${C.dim}${v.last.slice(0, 50)}${C.reset}`,
      );
    });

    out.push("");
    const selId = this.order[this.selected]!;
    const sv = this.views.get(selId)!;
    out.push(`${C.bold}Agent: ${selId}${C.reset}  ${C.dim}(Tab to switch)${C.reset}`);
    const recent = sv.recent.slice(-10);
    if (recent.length === 0) out.push(`  ${C.gray}(no events yet)${C.reset}`);
    for (const r of recent) out.push(`  ${C.gray}·${C.reset} ${r}`);

    if (this.pending.length > 0) {
      const p = this.pending[0]!;
      out.push("");
      out.push(`${C.bold}${C.yellow}⚠ Permission needed${C.reset} — ${p.agent}: ${C.bold}${p.question}${C.reset}`);
      out.push(
        "   " +
          p.options.map((o, i) => `${C.bold}${i + 1}${C.reset}) ${o.name}${o.kind ? ` ${C.dim}(${o.kind})${C.reset}` : ""}`).join("   "),
      );
      out.push(`   ${C.dim}press 1-${p.options.length} to decide${C.reset}`);
    }

    out.push("");
    out.push(`${C.bold}Activity${C.reset}`);
    for (const l of this.logs.slice(-6)) out.push(`  ${C.gray}${l}${C.reset}`);

    out.push("");
    const demoHint = this.onDemo ? " · d run demo" : "";
    out.push(`${C.dim}keys: Tab switch agent · 1-9 decide permission${demoHint} · q quit${C.reset}`);

    process.stdout.write(out.join("\n"));
  }
}
