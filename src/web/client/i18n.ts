// Lightweight i18n. Strings are keyed; `t(key, vars?)` returns the active language's
// value (falling back to the key). Core product nouns (mesh / router / agent / harness)
// stay in English in both languages — they're technical identifiers used throughout.
import { createContext, useContext } from "react";

export type Lang = "en" | "zh";

type Entry = [en: string, zh: string];

const DICT: Record<string, Entry> = {
  // ── the Mesh Assistant (renamed from "master" — the NL meshes-control assistant) ──
  conductor: ["Mesh Assistant", "Mesh 助手"],
  "conductor.sub": ["create / edit / start / stop meshes in natural language", "用自然语言 创建 / 编辑 / 启停 mesh"],
  "conductor.absent": [
    "Mesh Assistant not configured — use the mesh list to control meshes directly",
    "Mesh 助手未配置 —— 直接用 mesh 列表来控制",
  ],
  "conductor.placeholder": ["instruct the Mesh Assistant…", "给 Mesh 助手下达指令…"],
  "conductor.starting": ["Mesh Assistant is starting…", "Mesh 助手启动中…"],

  // ── topbar ──
  live: ["live", "在线"],
  offline: ["offline", "离线"],
  reload: ["reload", "重载"],
  back: ["back", "返回"],
  "hint.select": ["select", "选择"],
  "hint.full": ["full", "全屏"],
  "hint.new": ["new", "新建"],
  "hint.reload": ["reload", "重载"],
  "reload.confirm": ["reload?", "确认重载?"],
  "hint.permit": ["permit", "批准"],
  "hint.back": ["back", "返回"],
  "hints.all": [
    "keyboard:  ↑↓ select mesh · f fullscreen · n new mesh · r reload · 1-9 resolve permission · esc back",
    "快捷键:  ↑↓ 选择 mesh · f 全屏 · n 新建 mesh · r 重载 · 1-9 处理权限 · esc 返回",
  ],
  "overview.hint": [
    "select a mesh from the list to open its console — topology, unified conversation tabs, permissions, and live mail/activity timelines.",
    "从列表选择一个 mesh 打开它的控制台 —— 拓扑、统一对话标签、权限,以及实时邮件/活动时间线。",
  ],

  // ── status ──
  "st.ready": ["ready", "就绪"],
  "st.starting": ["starting", "启动中"],
  "st.running": ["running", "运行中"],
  "st.stopped": ["stopped", "已停止"],
  "st.dead": ["dead", "已退出"],
  "st.spawning": ["spawning", "启动中"],
  "st.cold": ["cold", "冷启动"],
  "st.absent": ["absent", "未配置"],

  // ── mesh list ──
  meshes: ["meshes", "meshes"],
  "new": ["new", "新建"],
  "meshes.empty": [
    "no meshes — define one with + new, or ask the Mesh Assistant",
    "暂无 mesh —— 用「+ 新建」定义一个,或让 Mesh 助手来创建",
  ],
  start: ["start", "启动"],
  stop: ["stop", "停止"],
  "stop.confirm": ["stop?", "确认停止?"],
  edit: ["edit", "编辑"],
  del: ["delete", "删除"],
  "del.confirm": ["delete?", "确认删除?"],
  "start mesh": ["start mesh", "启动 mesh"],
  "stop mesh": ["stop mesh", "停止 mesh"],
  "start.strategy": ["start plan", "启动方案"],
  "start.strategy.hint": ["choose whether agents resume saved sessions or start fresh", "选择 agent 是继承旧 session 还是全新启动"],
  "start.strategy.resume": ["inherit session", "继承旧 session"],
  "start.strategy.fresh": ["fresh session", "全新 session"],
  router: ["router", "router"],
  agents: ["{n} agents", "{n} 个 agent"],

  // ── detail panels ──
  topology: ["topology", "拓扑"],
  "topology.sub": ["agents · mail edges", "agent · 邮件边"],
  "edge.from": ["edge from", "边起点"],
  "edge.to": ["edge to", "边终点"],
  "edge.add": ["+ edge", "+ 边"],
  "agent.id": ["agent id", "agent id"],
  "agent.harness": ["agent harness", "agent harness"],
  "agent.add": ["+ agent", "+ agent"],
  actions: ["actions", "操作"],
  manage: ["manage", "管理"],
  "topology.manage": ["manage topology", "管理拓扑"],
  conversation: ["Conversation", "对话"],
  "canvas.title": ["Canvas", "画板"],
  "router chat": ["router chat", "router 对话"],
  interrupt: ["interrupt", "中断"],
  "interrupt.current": ["interrupt current agent", "中断当前 agent 回合"],
  wake: ["start", "启动"],
  "wake.hint": ["start this cold lazy agent", "启动这个冷态 lazy agent"],
  "new session": ["new session", "新会话"],
  "new session.confirm": ["reset?", "确认重置?"],
  "new session.hint": ["switch this agent to a fresh session (clears its context)", "把该 agent 切到新会话（清空上下文）"],
  "new sessions all": ["new sessions", "全部新会话"],
  "new sessions all.confirm": ["reset all?", "确认全部重置?"],
  "new sessions all.hint": ["switch every agent to a fresh session", "把所有 agent 切到新会话"],
  "session.reset.divider": ["new session", "新会话"],
  full: ["full", "全屏"],
  exit: ["exit", "退出"],
  "router.placeholder": ["talk to the router… (Enter send)", "与 router 对话…(Enter 发送)"],
  "agent.placeholder": ["message {id}… (Enter send · Ctrl+Enter steer)", "发消息给 {id}…(Enter 发送 · Ctrl+Enter 打断引导)"],
  mode: ["mode", "模式"],
  "mode.hint": ["initial permission/operating mode (the agent can also switch at runtime)", "初始许可/工作模式(运行时也可切换)"],
  "mode.default": ["default", "默认"],
  model: ["model", "模型"],
  "model.hint": ["runtime model advertised by this agent", "该 agent 当前广告的运行时模型"],
  effort: ["effort", "思考强度"],
  "effort.hint": ["thinking effort — saved now, applies on the agent's next start (does not restart a running mesh)", "思考强度 —— 立即保存,在 agent 下次启动时生效(不会重启运行中的 mesh)"],
  "effort.hint.live": ["thinking effort (read-only while running — stop the mesh to change)", "思考强度(运行中只读 —— 停止 mesh 后可修改)"],
  "effort.default": ["default", "默认"],
  "effort.minimal": ["minimal", "最小"],
  "effort.low": ["low", "低"],
  "effort.medium": ["medium", "中"],
  "effort.high": ["high", "高"],
  activity: ["activity", "活动"],
  "activity.sub": ["mail · steer · interrupt · permission · log", "邮件 · 引导 · 中断 · 权限 · 日志"],
  mailbox: ["mailbox", "邮箱"],
  "mailbox.sub": ["inter-agent mail", "agent 间邮件"],
  "permission history": ["permission history", "权限历史"],
  "tab.activity": ["activity", "活动"],
  "tab.mail": ["mail", "邮件"],
  "tab.history": ["history", "历史"],
  "tabs.allMembers": ["all {n} members", "全部 {n} 个成员"],

  // ── empties ──
  "empty.members": ["no member agents", "没有成员 agent"],
  "empty.messages": ["no messages yet", "暂无消息"],
  "empty.activity": ["no activity yet", "暂无活动"],
  "empty.mail": ["no mail yet", "暂无邮件"],
  "empty.history": ["no resolved permissions", "暂无已处理权限"],
  "empty.select": ["select a mesh from the list", "从列表选择一个 mesh"],

  // ── permission ──
  permission: ["permission", "权限"],

  // ── transcript ──
  you: ["you", "你"],
  agent: ["agent", "agent"],
  thinking: ["thinking", "思考"],
  "tool.input": ["input", "输入"],
  "tool.files": ["files", "文件"],
  "tool.output": ["output", "输出"],
  plan: ["plan", "计划"],
  "mail.from": ["from {from}", "来自 {from}"],

  // ── mobile segments ──
  "seg.chat": ["Chat", "对话"],
  "seg.agents": ["Agents", "成员"],
  "seg.map": ["Map", "拓扑"],
  "seg.log": ["Log", "日志"],

  // ── composer ──
  "queue.count": ["queued: {current}/{count}", "队列: {current}/{count}"],
  "composer.placeholder": [
    "type a message…  (Enter send · Ctrl+Enter steer · Shift+Enter newline)",
    "输入消息…(Enter 发送 · Ctrl+Enter 打断引导 · Shift+Enter 换行)",
  ],

  // ── theme / language chrome ──
  theme: ["theme", "主题"],
  "theme.custom": ["Custom", "自定义"],
  "theme.customize": ["customize theme", "自定义主题"],
  "theme.startFrom": ["start from", "基于"],
  "theme.io": ["export / import (JSON)", "导出 / 导入 (JSON)"],
  "theme.fromCurrent": ["↧ from current", "↧ 取当前"],
  "theme.applyJson": ["↥ apply JSON", "↥ 应用 JSON"],
  "theme.save": ["save as custom", "保存为自定义"],
  cancel: ["cancel", "取消"],
  apply: ["apply", "应用"],
  esc: ["esc", "退出"],
  expand: ["expand", "展开"],
  reset: ["reset", "重置"],
  language: ["language", "语言"],

  // ── mesh builder ──
  "build.define": ["define mesh", "定义 mesh"],
  "build.edit": ['edit mesh "{name}"', '编辑 mesh「{name}」'],
  "build.basic": ["basic", "基础信息"],
  "build.name": ["mesh name", "mesh 名称"],
  "build.name.locked": ["mesh name (locked)", "mesh 名称(锁定)"],
  "build.agents": ["agents — exactly one router", "agents —— 恰好一个 router"],
  "build.addAgent": ["+ agent", "+ agent"],
  "build.instructions": ["role-specific instructions (optional)", "专属指令（可选）"],
  "build.instructions.placeholder": [
    "Only this agent sees this. Applies on the next start.",
    "仅该 agent 可见,下次启动时生效。",
  ],
  "build.edges": ["mail edges — from → to (directed)", "邮件边 —— from → to(有向)"],
  "build.steer": ["steer", "引导"],
  "build.lazy": ["lazy start", "懒启动"],
  "build.lazy.tooltip": ["Start this member only on first mail or manual wake.", "仅在收到首封邮件或手动唤醒时启动该成员。"],
  "build.steer.tooltip": [
    "Allow this agent to cancel the recipient's current turn, including router/human-started turns, and steer ahead of queued mail.",
    "允许该 agent 取消收件人当前回合（含 router/人类发起的回合）并插队引导。",
  ],
  "build.addEdge": ["+ edge", "+ 边"],
  "build.charter": [
    "team charter — shared goal + norms, injected into every agent (optional)",
    "团队章程 —— 共同目标 + 规范,会注入给每个 agent(可选)",
  ],
  "build.save": ["save mesh", "保存 mesh"],
  "build.saving": ["saving…", "保存中…"],
  "build.defining": ["defining…", "定义中…"],
};

export function translate(key: string, lang: Lang, vars?: Record<string, string | number>): string {
  const e = DICT[key];
  let s = e ? (lang === "zh" ? e[1] : e[0]) : key;
  if (vars) for (const [k, v] of Object.entries(vars)) s = s.replaceAll(`{${k}}`, String(v));
  return s;
}

const LANG_KEY = "mesh.lang";

export function loadLang(): Lang {
  try {
    const l = localStorage.getItem(LANG_KEY);
    if (l === "zh" || l === "en") return l;
  } catch {
    /* unavailable */
  }
  try {
    if (typeof navigator !== "undefined" && navigator.language?.toLowerCase().startsWith("zh")) return "zh";
  } catch {
    /* unavailable */
  }
  return "en";
}

export function saveLang(l: Lang): void {
  try {
    localStorage.setItem(LANG_KEY, l);
    document.documentElement.lang = l;
  } catch {
    /* unavailable */
  }
}

export type TFn = (key: string, vars?: Record<string, string | number>) => string;
export const I18nContext = createContext<{ lang: Lang; t: TFn }>({ lang: "en", t: (k) => k });
export const useI18n = () => useContext(I18nContext);
/** Translate a status enum value via the st.* keys. */
export const tStatus = (t: TFn, status: string) => t(`st.${status}`);
