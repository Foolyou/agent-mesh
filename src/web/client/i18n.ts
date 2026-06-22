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
  "reload.confirm": ["reload?", "确认重载?"],
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
  send: ["send message", "发送消息"],
  wake: ["start", "启动"],
  "wake.hint": ["start this agent", "启动这个 agent"],
  "agent.stop": ["stop", "停止"],
  "agent.stop.hint": ["stop this agent process", "停止这个 agent 进程"],
  "agent.spawning": ["starting", "启动中"],
  "agent.spawning.hint": ["agent is starting", "agent 正在启动"],
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
  "agent.placeholder": ["message {id}… (Enter send)", "发消息给 {id}…(Enter 发送)"],
  mode: ["mode", "模式"],
  "mode.hint": ["initial permission/operating mode (the agent can also switch at runtime)", "初始许可/工作模式(运行时也可切换)"],
  "mode.default": ["default", "默认"],
  model: ["model", "模型"],
  "model.hint": ["runtime model advertised by this agent", "该 agent 当前广告的运行时模型"],
  effort: ["effort", "思考强度"],
  "effort.hint": ["thinking effort — saved now, applies on the agent's next start unless runtime switching is supported", "思考强度 —— 立即保存；若不支持运行时切换，则下次启动生效"],
  "effort.hint.live": ["thinking effort (spawn-time only for this harness — stop the mesh to change)", "思考强度(该 harness 仅启动时生效 —— 停止 mesh 后可修改)"],
  "effort.hint.runtime": ["runtime thinking effort advertised by this agent", "该 agent 支持的运行时思考强度"],
  "ocperm": ["opencode permission", "opencode 权限"],
  "ocperm.hint": ["opencode-only spawn-time permission — 'allow' grants autonomous tool use; other harnesses set permission via the mode picker", "仅 opencode 的启动时权限 —— 'allow' 允许自主执行工具；其它 harness 在 mode 下拉里设置权限"],
  "ocperm.allow": ["allow (autonomous)", "allow（自主）"],
  "ocperm.ask": ["ask (default)", "ask（默认）"],
  "effort.default": ["default", "默认"],
  "effort.minimal": ["minimal", "最小"],
  "effort.low": ["low", "低"],
  "effort.medium": ["medium", "中"],
  "effort.high": ["high", "高"],
  "effort.xhigh": ["xhigh", "超高"],
  "effort.max": ["max", "最大"],
  // ("thinking" label already defined below for transcript thinking blocks — reused here.)
  "thinking.hint": ["kimi thinking mode — toggles the model's ,thinking variant at runtime", "kimi 思考模式 —— 运行时切换模型的 ,thinking 变体"],
  "thinking.off": ["off", "关"],
  "thinking.on": ["on", "开"],
  activity: ["activity", "活动"],
  "activity.sub": ["mail · steer · interrupt · permission · log", "邮件 · 引导 · 中断 · 权限 · 日志"],
  mailbox: ["mailbox", "邮箱"],
  "mailbox.sub": ["inter-agent mail", "agent 间邮件"],
  "permission history": ["permission history", "权限历史"],
  "tab.activity": ["activity", "活动"],
  "tab.mail": ["mail", "邮件"],
  "tab.history": ["history", "历史"],
  "tab.board": ["board", "看板"],
  "board.newEpic": ["+ epic", "+ 史诗"],
  "board.newTask": ["+ task", "+ 任务"],
  "board.addSubtask": ["+ subtask", "+ 子任务"],
  "board.comment": ["comment…", "评论…"],
  "board.noEpic": ["no epic", "无史诗"],
  "board.unassigned": ["unassigned", "未指派"],
  "board.deps": ["deps", "依赖"],
  "board.depsPlaceholder": ["deps e.g. 1,2", "依赖 如 1,2"],
  // ── issue-panel Phase 2: list/detail workspace ──
  "board.viewList": ["list", "列表"],
  "board.viewBoard": ["board", "看板"],
  "board.fullscreen": ["toggle fullscreen", "切换全屏"],
  "board.back": ["back", "返回"],
  "board.filterText": ["filter…", "筛选…"],
  "board.filterStatus": ["filter by status", "按状态筛选"],
  "board.filterAssignee": ["filter by assignee", "按指派人筛选"],
  "board.filterEpic": ["filter by epic", "按史诗筛选"],
  "board.allStatus": ["all status", "全部状态"],
  "board.allAssignees": ["all assignees", "全部指派人"],
  "board.allEpics": ["all epics", "全部史诗"],
  "board.sort": ["sort", "排序"],
  "board.sortUpdated": ["recently updated", "最近更新"],
  "board.sortPriority": ["priority", "优先级"],
  "board.sortId": ["number", "编号"],
  "board.groupByEpic": ["group by epic", "按史诗分组"],
  "board.noMatches": ["no issues match the filter", "没有符合筛选的任务"],
  // ── labels (Phase 4) ──
  "board.labels": ["labels", "标签"],
  "board.filterLabel": ["filter by label", "按标签筛选"],
  "board.allLabels": ["all labels", "全部标签"],
  "board.noLabel": ["no label", "无标签"],
  "board.manageLabels": ["labels", "标签管理"],
  "board.labelName": ["label name", "标签名"],
  "board.addLabel": ["+ label", "+ 标签"],
  "board.deleteLabel": ["delete label", "删除标签"],
  // ── detail view ──
  "board.subtasks": ["subtasks", "子任务"],
  "board.lifecycle": ["lifecycle", "生命周期"],
  "board.linkedMail": ["linked mail", "关联邮件"],
  "board.comments": ["comments", "评论"],
  "board.close": ["close issue", "关闭任务"],
  "board.closeAnyway": ["close anyway…", "仍然关闭…"],
  "board.confirmCloseAs": ["close as:", "关闭为:"],
  "board.closeDone": ["done", "完成"],
  "board.closeCancelled": ["cancelled", "取消"],
  "board.reopen": ["reopen", "重新打开"],
  "board.terminalNote": ["this issue is closed", "此任务已关闭"],
  "board.openSubtasks": ["open subtasks", "未完成子任务"],
  "board.blockingDeps": ["incomplete dependencies", "未完成依赖"],
  "board.needsIntegration": ["no integration_ready signal yet", "尚无 integration_ready 信号"],
  "board.dispatchBrief": ["dispatch brief", "派活简报"],
  "board.mailFailed": ["mail failed", "邮件失败"],
  "board.mailSent": ["mail sent", "邮件已发"],
  "tabs.allMembers": ["all {n} members", "全部 {n} 个成员"],

  // ── empties ──
  "empty.members": ["no member agents", "没有成员 agent"],
  "empty.messages": ["no messages yet", "暂无消息"],
  "empty.activity": ["no activity yet", "暂无活动"],
  "empty.mail": ["no mail yet", "暂无邮件"],
  "empty.history": ["no resolved permissions", "暂无已处理权限"],
  "empty.board": ["board is empty", "看板为空"],
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
  "transcript.jumpBottom": ["Jump to bottom", "回到底部"],
  "transcript.loading": ["loading transcript...", "正在加载对话..."],

  // ── mobile segments ──
  "seg.chat": ["Chat", "对话"],
  "seg.agents": ["Agents", "成员"],
  "seg.map": ["Map", "拓扑"],
  "seg.log": ["Log", "日志"],

  // ── composer ──
  "queue.count": ["queued: {current}/{count}", "队列: {current}/{count}"],
  "composer.placeholder": [
    "type a message…  (Enter send · Shift+Enter newline)",
    "输入消息…(Enter 发送 · Shift+Enter 换行)",
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
  "build.autoCompact": ["Auto-compact", "自动 compact"],
  "build.autoCompact.enable": ["Enable auto-compact", "启用自动 compact"],
  "build.autoCompact.threshold": ["threshold", "阈值"],
  "build.autoCompact.help": [
    'percent "85%" / absolute tokens "200000 tokens" / remaining tokens "-20000"',
    '百分比 "85%" / 绝对 token "200000 tokens" / 剩余 token "-20000"',
  ],
  "build.autoCompact.invalid": ["auto-compact threshold is invalid", "自动 compact 阈值无效"],
  "build.overview": ["overview", "总体"],
  "build.agentPage": ["agent: {id}", "agent：{id}"],
  "build.agents": ["agents — exactly one router", "agents —— 恰好一个 router"],
  "build.addAgent": ["+ agent", "+ agent"],
  "build.deleteAgent": ["delete agent", "删除 agent"],
  "build.harness.notInstalled": ["not installed", "未检测到"],
  "build.harness.refreshFailed": ["harness detection failed", "harness 检测失败"],
  "build.model.default": ["harness default", "harness 默认"],
  "build.model.hint": ["model to apply when this agent starts", "该 agent 启动时应用的模型"],
  "build.model.loading": ["loading models…", "正在加载模型…"],
  "build.model.notAdvertised": ["not in probed list", "未在探测列表"],
  "build.model.retry": ["model probe failed · retry", "模型探测失败 · 重试"],
  "build.group.identity": ["identity", "身份"],
  "build.group.runtime": ["runtime", "运行"],
  "build.group.model": ["model & runtime opts", "模型与高级选项"],
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

  // ── /bnw shell + nav (i18n foundation slice). Technical nouns (mesh/router/agent/harness/
  //    edge/epic/issue + feature names Harness/Doctor) stay English in BOTH languages. ──
  "bnw.connected": ["connected", "在线"],
  "bnw.offline": ["offline", "离线"],
  "bnw.selectMesh": ["select mesh", "选择 mesh"],
  "bnw.meshes": ["meshes", "meshes"],
  "bnw.newMeshShort": ["new", "新建"],
  "bnw.noMesh": ["no mesh", "无 mesh"],
  "bnw.connecting": ["connecting…", "连接中…"],
  "bnw.reloadDefs": ["reload mesh definitions", "重新加载 mesh 定义"],
  "bnw.reloadConfirm": ["reload?", "重新加载?"],
  "bnw.runtime": ["runtime", "运行态"],
  "bnw.board": ["board", "看板"],
  "bnw.canvas": ["canvas", "画布"],
  "bnw.assistant": ["assistant", "助手"],
  "bnw.assistantFull": ["Mesh Assistant", "Mesh 助手"],
  "bnw.harness": ["Harness", "Harness"],
  "bnw.harnesses": ["Harnesses", "Harnesses"],
  "bnw.channels": ["channels", "渠道"],
  "bnw.doctor": ["Doctor", "Doctor"],
  "bnw.doctorSystem": ["Doctor / system", "Doctor / 系统"],
  "bnw.settings": ["settings", "设置"],
  "bnw.notifications": ["notifications", "通知"],
  "bnw.unread": ["unread notifications", "未读通知"],
  "bnw.more": ["more", "更多"],
  "bnw.closeMore": ["close more", "关闭更多"],
  "bnw.newMesh": ["new mesh", "新建 mesh"],
  "bnw.management": ["management", "管理"],
  "bnw.mainNav": ["main navigation", "主导航"],
  "bnw.shell.offline": [
    "Disconnected — reconnecting… (showing last known; changes disabled)",
    "连接已断开 — 正在重连…（显示最近已知内容，变更已禁用）",
  ],
  "bnw.reconnect": ["reconnect now", "立即重连"],
  "bnw.nf.title": ["404 · page not found", "404 · 页面不存在"],
  "bnw.nf.desc": ["no matching /bnw route:", "没有匹配的 /bnw 路由："],
  "bnw.nf.home": ["back to console", "返回控制台"],
  "bnw.eb.title": ["surface error", "界面错误"],
  "bnw.eb.head": ["this surface crashed", "这个界面出错了"],
  "bnw.eb.body": [
    "a render error was thrown — the topbar and navigation still work. retry this surface or go home.",
    "渲染时抛出异常——顶栏与导航仍可用。可重试本界面或返回首页。",
  ],
  "bnw.eb.retry": ["retry", "重试"],
  "bnw.eb.home": ["back home", "返回首页"],

  // ── /bnw runtime body (i18n runtime slice). Identifiers stay English: mesh/router/agent/
  //    harness/model/mode/effort/Kimi/edge/canvas/prompt + session-strategy values. ──
  "bnw.rt.context": ["context", "上下文"],
  "bnw.rt.pending": ["pending", "待审批"],
  "bnw.rt.meshMissing": ["mesh not found", "mesh 不存在"],
  "bnw.rt.meshMissingDesc": ["no mesh named “{name}”.", "没有名为「{name}」的 mesh。"],
  "bnw.rt.noAgents": ["no agents", "无 agent"],
  "bnw.rt.noAgentsDesc": ["this mesh has no agents yet.", "这个 mesh 还没有 agent。"],
  "bnw.rt.working": ["working", "工作中"],
  "bnw.rt.sig.rate_limited": ["rate limited", "已限流"],
  "bnw.rt.sig.retrying": ["retrying", "重试中"],
  "bnw.rt.sig.compacting": ["compacting", "压缩中"],
  "bnw.rt.silentComplete": ["silent completes", "静默完成"],
  "bnw.rt.steps": ["steps", "步"],
  "bnw.rt.focus": ["focus", "聚焦"],
  "bnw.rt.overview": ["overview", "概览"],
  "bnw.rt.full": ["full", "全屏"],
  "bnw.rt.exitFull": ["exit full", "退出全屏"],
  "bnw.rt.agentMissing": ["agent not found", "agent 不存在"],
  "bnw.rt.agentMissingDesc": ["mesh “{mesh}” has no agent “{agent}”.", "mesh「{mesh}」没有 agent「{agent}」。"],
  "bnw.rt.backOverview": ["back to overview", "返回概览"],
  "bnw.rt.noTranscript": ["this agent has no transcript yet.", "该 agent 还没有转写记录。"],
  "bnw.rt.loadOlder": ["load older", "载入更早"],
  "bnw.rt.wakeBtn": ["Wake", "唤醒"],
  "bnw.rt.newSession": ["new session", "新会话"],
  "bnw.rt.newSessionConfirm": ["new session? (resets this agent's session)", "新会话?（重置该 agent 会话）"],
  "bnw.rt.interrupt": ["interrupt", "打断"],
  "bnw.rt.send": ["Send", "发送"],
  "bnw.rt.steer": ["Steer", "引导"],
  "bnw.rt.steerHint": ["agent is working — your message will steer it", "agent 正在工作 —— 发送将作为 steer 插入"],
  "bnw.rt.composerPlaceholder": ["message {agent}…", "给 {agent} 发消息…"],
  "bnw.rt.pendingApproval": ["⚠ pending approval (oldest)", "⚠ 待授权（最早一条）"],
  "bnw.rt.moreApprovals": ["{n} more pending", "还有 {n} 个待授权"],
  "bnw.rt.noQueue": ["no queued prompts.", "无排队 prompt。"],
  "bnw.rt.queued": ["queued", "排队"],
  "bnw.rt.nextUp": ["next", "下一条"],
  "bnw.rt.add": ["add", "添加"],
  "bnw.rt.projectPath": ["project path", "项目路径"],
  "bnw.cv.title": ["topology canvas", "拓扑画布"],
  "bnw.cv.active": ["active", "活跃"],
  "bnw.cv.forceLayout": ["force-directed", "力导向"],
  "bnw.cv.relayout": ["relayout", "重新布局"],
  "bnw.cv.escClose": ["Esc to close", "Esc 关闭"],
  "bnw.cv.flowDir": ["flow direction (mail)", "信息流方向（mail）"],
  "bnw.cv.recentMail": ["highlight = recent mail flow", "高亮 = 近期有 mail 流动"],
  "bnw.cv.dragPin": ["drag = pin", "拖拽=固定"],
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

// Subscribers re-render on a language change so a `saveLang` from anywhere (e.g. the settings
// language tab) updates every consumer immediately, no refresh. Module-level so it's decoupled
// from any single provider and survives across the /bnw tree.
const langListeners = new Set<(l: Lang) => void>();
export function subscribeLang(cb: (l: Lang) => void): () => void {
  langListeners.add(cb);
  return () => { langListeners.delete(cb); };
}

export function saveLang(l: Lang): void {
  try {
    localStorage.setItem(LANG_KEY, l);
  } catch {
    /* unavailable */
  }
  try {
    if (typeof document !== "undefined") document.documentElement.lang = l;
  } catch {
    /* unavailable */
  }
  // Notify regardless of storage/DOM availability so the live UI still re-renders.
  for (const cb of langListeners) { try { cb(l); } catch { /* listener threw */ } }
}

export type TFn = (key: string, vars?: Record<string, string | number>) => string;
export const I18nContext = createContext<{ lang: Lang; t: TFn }>({ lang: "en", t: (k) => k });
export const useI18n = () => useContext(I18nContext);
/** Translate a status enum value via the st.* keys. */
export const tStatus = (t: TFn, status: string) => t(`st.${status}`);
