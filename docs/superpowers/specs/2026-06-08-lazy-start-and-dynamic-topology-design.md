# Agent 懒启动 + 运行时动态拓扑（加边 / 加 Agent）— Design

Date: 2026-06-08
Status: Approved (三方收敛：Planner + Executor + Reviewer)，分步交付
交付方式：**三阶段，每完成一个 commit → Reviewer 审 → push，再开下一个**

## Goal

让 mesh 的成员不必全部随 Router 一起启动，并让拓扑可以在运行时增量扩展：

1. **Agent 懒启动（P1）**：每个 agent 在配置里 opt-in 勾选「懒启动」。没勾的随 Router 一起 eager 启动（行为不变）；勾了的初始不起进程（`cold`），由用户手动或「首封邮件到达」按需拉起，启动后读取（drain）已到达的邮件。
2. **运行时加边（P2）**：在 mesh 运行中增量新增一条 mail 边，权限即时生效并落盘，无需重启。
3. **运行时加 Agent（P3）**：在 mesh 运行中增量新增一个成员（默认 cold 懒启动）并连边，权限即时生效并落盘。

**明确非目标：删除（删 Agent / 删边）本期不做，走冷重启**（`scripts/update.sh --cold`）。理由见末节风险表。

## 现状（grounding）

控制面拓扑与生命周期：
- **启动是 eager 串行**：`control-plane.ts:183-256` 的 `start()` 循环 spawn **全部** agent，每个阻塞在 `conn.start()` → `initialize()` → `newSession()`（:209-211）。状态在 :208 emit `spawning`、:254-255 置 `ready`、:200 进程退出置 `dead`。
- **生命周期三态**：`acp/types.ts:60` `AgentStatus = "spawning" | "ready" | "dead"`。没有 `cold` / `pending` / `paused`。
- **拓扑静态**：`mesh.ts:42-45` `canMail` 读 `config.edges`；`mesh.ts:9-10` `Mesh.config` 当不可变用（构造时归一化一次）。`acp/types.ts:11-15` `MeshEdge {from,to,steer?}`，:50-58 `MeshConfig {name,agents,edges,charter}`。
- **发信路径**：`control-plane.ts:314-324` `handleSendMail` → `canMail` 校验（:316）→ `sendMail()` **先写信箱**（:319）→ emit（:320）→ `wake(to)` fire-and-forget（:322）。
- **wake 的关键现状**：`control-plane.ts:326-335` `wake(to)` 先 `this.conns.get(to)`，**conn 不存在就直接 return**（:328）。即给一个没起进程的 agent 发信，邮件已落盘但永远不会被唤醒——这正是懒启动要补的缺口。
- **mailbox 即权威事件源**：`sendMail()` 落盘在 `wake()` 之前；`handleCheckMail`（:370-376）用 `mailCursors` + `readMailFor` 增量读。**邮件已经持久化**，懒启动无需另造队列。
- **mesh_status 已含状态**：`meshStatusText`（:267-276）每行输出 `this.mesh.status(a.id)` 与 `canMail` 可达列表——`cold` 态会自动出现在这里，agent 与 router 都看得到。

进程/持久化架构（P2/P3 关键）：
- **ControlPlane 跑在可分离 daemon 内**（`mesh-host`），它持有运行中的 `Mesh`。`MeshManager`（父进程/backend）通过 `MeshHostClient` over Unix socket 跟 daemon 通信。
- **持久化在父进程**：`mesh-manager.ts:72-79` `defineMesh()` → `store.define()` 写 `<root>/meshes/<name>.json`，且 **running 时 throw**（:74-76）——这是「全量覆盖」的排他安全门。
- **已有「父持久化 + RPC 到 daemon」先例**：`setMode`/`setModel`（`mesh-manager.ts` ~253-269）既落盘又经 client RPC 热生效；`setAgentEffort`（:84-90）只落盘不碰 daemon。P2/P3 的增量写沿用这套 dual-write 模式。

## 决策（三方收敛，已与用户确认）

懒启动（P1）：
1. **per-agent opt-in**：`AgentConfig` 加 `lazy?: boolean`。没勾 = eager（随 Router 起）；勾了 = `cold`，不随启动 spawn。**Router 永远 eager**（人类网关），校验阶段拒绝 router 勾 lazy。
2. **触发语义 = C（手动 + 首封自动并存）**：用户可手动唤醒（API/UI 预热按钮）；Router 或任一已启动 agent 给 cold 目标发**被 canMail 放行**的邮件时，由 control-plane 自动 spawn。无边的邮件照常被 `canMail` 拒，不会误拉起。
3. **状态机扩为 `cold → spawning → ready/dead`**，`mesh_status` 暴露 `cold`。
4. **pending = 复用 mailbox**（Executor 边界）：首封邮件像普通邮件一样先落盘（已是现状），spawn ready 后由 control-plane 触发 drain，**不另造独立队列**。**P1 不扩 mailbox schema/状态机**（Executor 实现评审）：现 mailbox 只有 append + read cursor，无 pending/spawn-gated/failed 字段。P1 用「邮件已持久化 + cold/spawning 由 agent status 表达 + spawn 失败异步回执 + event/log」表达，pending-failed/retry 的 UI 与 mailbox schema 扩展推迟到 P1.5，避免 P1 被 mailbox 迁移拖大。
5. **drain = ready 后单条 check_mail 提示**（Executor 实现评审）：spawn ready 后**不**逐封 `wake()` 注入（会给新 ready 的 agent 并发开多个 prompt turn，和 `AcpAgentConnection` 的 prompt queue/turn 语义冲突）；而是发**一条** prompt「You have pending mail; call check_mail」，由 `handleCheckMail` 用 cursor 一次读全部积压。契合「mailbox 即权威源」。
6. **spawn 互斥用 `Map<agentId, Promise>`**（Reviewer）：细粒度按 agentId，不用全局锁；并发首封等待同一个 spawn promise，绝不起两个同 ID 进程。手动唤醒与首封自动**共用同一把锁**。spawn 内含 **timeout** 守卫，避免 init 挂死把 `ensureSpawned` 永久 wedge。
7. **mcp.register 幂等化**（Executor 实现评审）：`createMeshServicesServer.register` 每次 new transport + `entries.set`，非幂等；dead 后 retry / 重复 wakeAgent 会重复 register。`spawnAgent` 前维护 `registeredAgents` Set（或 register 显式 close/replace 旧 transport）。register 必须在 `newSession` 前完成（MCP HTTP path 依赖 entries 有该 id）。
8. **canMail 对 cold/spawning 的语义**：cold/spawning 不改 `canMail` 的真值（边在就是在），但**触发投递时**若目标非 ready 则进入 spawn-gated 路径。`mesh_status` 行内状态如实显示 cold/spawning，避免 Planner 误判「已就绪」。
9. **spawn 失败 = 异步回执，不阻塞发信方**（Executor 实现评审 + Reviewer 非静默要求的调和）：`send_mail` 保持 fire-and-forget 异步语义，**不**让首封工具阻塞到 agent init 完成/失败。spawn 失败时：agent 置 `dead` + emit event/log + **给原发件方发一封 `[SPAWN FAILED]` 回执 mail**（异步、非静默，发件方下次 check_mail 可见）。这样既不破坏 async delivery，又满足 Reviewer「不静默丢失」。
10. **pending 上限弱化到 P1.5**（Executor 实现评审修正 Reviewer）：原硬上限是防**内存队列** OOM；但 pending 复用**磁盘 mailbox**、无内存队列，OOM 风险大降，受磁盘容量约束。P1 暂不做数值硬上限；如需，P1.5 以「按收件人未读数上限」实现（需先补 mailbox 未读计数 API）。

动态新增（P2/P3）：
11. **增量 PATCH 而非全量 PUT**（Reviewer）：保留 `defineMesh` running-throw 只挡「全量覆盖」；**新增 `addEdge` / `addAgent` 增量接口**，允许 running 时调用。
12. **原子双写**：落盘走 temp 写 + rename 原子替换；内存（daemon 内 running `Mesh`）与磁盘要么都成、要么回滚。沿用 setMode/setModel 的「父落盘 + client RPC 到 daemon」dual-write。
13. **权限即时强一致 + 认知按需收敛**：`canMail` 读 live config 立即生效（强一致执行，绝不越权）；运行中 agent 的 roster 认知滞后通过 **send_mail 层兜底**收敛（见 14），不靠等 session 自然结束（给「最终」定上界）。
14. **briefing 陈旧的兜底 = send_mail 层即时补提示**（Reviewer 主方案，取代主动广播）：发件方 briefing 里没有目标、但 edges 里有该边 → **以 edges 为准放行** + 给发件方补一句「你有一个未感知的新 peer X（状态：cold/spawning/ready）」系统提示。on-demand 收敛，不无差别打扰全员、更省 token。
15. **system note 原语（可选优化 / P3 内）三约束**（Reviewer）：若实现主动 roster 刷新，则 (a)「下一轮」= agent **下次消费 mailbox/事件时**，非物理时间，跨 transport（stdio/sse）统一定义；(b) note **走 mailbox 队列**投递继承持久化/ack，连续多次变更**合并为最新一份**；(c) note **带 peer 状态快照**（新 peer 标 cold/spawning），避免老 agent 看 roster 立刻发却卡 pending 的「发了没动静」。
16. **addEdge 前校验** target 不是 `dead`（避免把边挂到永远起不来的 agent）。
17. **P3a 稳妥起步**：可先支持「新增 cold 孤立 agent（无边）做预热」，再开「新增 + 连边」。

删除：
18. **本期不做**，走 `scripts/update.sh --cold` 冷重启。论据见风险表。

## 设计

### P1 — Agent 懒启动

**数据模型**（`acp/types.ts`）：
- `AgentConfig` 加 `lazy?: boolean`（默认 false/undefined = eager）。
- `AgentStatus` 扩为 `"cold" | "spawning" | "ready" | "dead"`。同步 `MeshEvent.agent_status` 的联合类型与所有消费方（`web/types.ts`、前端状态徽标）。

**校验**（`mesh-validate.ts`）：router 角色不得 `lazy:true`（人类网关必须可达）。

**启动拆分**（`control-plane.ts`）：
- 把 `start()` 循环体里「单 agent 的 register + spawn + init + newSession + 模式/模型/能力协商 + 置 ready」抽成私有 `spawnAgent(a: AgentConfig): Promise<void>`，可被懒触发复用。register **必须在 newSession 前**完成（MCP HTTP path 依赖 entries 有该 id）。
- **register 幂等**（Executor 评审）：维护 `registeredAgents: Set<AgentId>`（或 register 显式 close/replace 旧 transport），避免 dead→retry / 重复 wakeAgent 时重复 `entries.set` + new transport。
- `start()`：eager agent（`!a.lazy`）走 `spawnAgent`；lazy agent 只 `this.mesh.setStatus(a.id, "cold")` + emit `agent_status: cold`，**不建 conn、不 register、无子进程**。
- **spawn 锁**：`private spawning = new Map<AgentId, Promise<void>>()`。`ensureSpawned(id)`：若 ready 直接返回；若 cold/缺 conn 则取/建 `spawning` promise（内部调 `spawnAgent`，带 **spawn timeout** 守卫），并发调用 await 同一个；成功后从 map 删除，失败置 `dead` 并删除（允许后续重试）。

**首封自动触发**（`control-plane.ts` `handleSendMail` / `wake`）：
- `handleSendMail` 通过 `canMail` 后，`sendMail()` 落盘不变，工具**立即返回**（保持 fire-and-forget async delivery，不阻塞发信方）。投递阶段：若 `this.mesh.status(to) !== "ready"` 且 agent 是 lazy/cold → 异步 `wakeLazy(to, from)`，否则现有 `wake(to)`。
- `wakeLazy(to, from)`（异步、不阻塞 send_mail 返回）：`await ensureSpawned(to)`；**ready 后 drain = 发一条 prompt「You have pending mail; call check_mail」**，由 `handleCheckMail` 用 cursor 一次读全部积压（**不**逐封 wake 注入，避免并发多 turn 与 ACP queue 冲突）。spawn 失败 → agent 置 `dead` + emit event/log + **给 `from` 发一封 `[SPAWN FAILED]` 回执 mail**（异步非静默，发件方下次 check_mail 见）；积压邮件保留在 mailbox。
- pending 上限：P1 不做数值硬上限（pending 即磁盘 mailbox，无内存队列 OOM），见决策 10。

**手动唤醒**：
- `ControlPlane` 暴露 `wakeAgent(id)`（经 daemon RPC / `MeshManager` / `web/api.ts` / `store`）→ `ensureSpawned(id)`，ready 后同样发 check_mail drain 提示。UI 在 cold agent 上给「启动」按钮。共用同一把 spawn 锁，与首封自动不冲突。

**mesh_status**：`meshStatusText` 无需改逻辑（已输出 `this.mesh.status`）；cold/spawning 自然显示。

### P2 — 运行时加边

- **接口**：`MeshManager.addEdge(name, edge: MeshEdge)`；daemon 侧 `ControlPlane.addEdge(edge)`。
- **流程**（dual-write，沿用 setMode 先例）：校验（from/to 存在、to 非 dead、边不重复、steer→router 拒绝复用现有 `mesh-validate`）→ daemon 内 mutate running `Mesh.config.edges`（需让 `Mesh` 支持增量加边，见下）→ 父进程 `store` 原子增量写（temp+rename）。任一失败回滚内存。
- **`Mesh` 可变化最小改动**：新增 `Mesh.addEdge(edge)` / `Mesh.addAgent(cfg)` 方法在内部 push 到 `config.edges` / `config.agents`（`config` 仍 readonly 引用，但内部数组可控增长；或改为持有可变副本）。`canMail` 立即读到新边 → 权限强一致生效。
- **认知收敛**：见 P2/P3 共用的 send_mail 兜底（决策 12）。加边瞬间，`from` agent 的 briefing 可能没列 `to`；下次它 `send_mail(to)` 时 edges 已放行 + 补「新 peer」提示。
- emit 一条事件（如 `kind:"topology"` 或复用 log）让 UI 拓扑图刷新。

### P3 — 运行时加 Agent

- **接口**：`MeshManager.addAgent(name, cfg: AgentConfig, edges?: MeshEdge[])`；daemon 侧 `ControlPlane.addAgent(cfg)` + 逐条 `addEdge`。
- **流程**：校验（id 唯一、harness 合法、非 router 重复）→ daemon `Mesh.addAgent`，**默认置 cold**（新成员天然懒启动，不立即 spawn）→ 注册可 spawn（复用 P1 `spawnAgent` / `ensureSpawned`）→ 可选连边（P2 `addEdge`）→ 父进程原子增量落盘。
- **新 agent 视角无陈旧**：它一旦 spawn，`newSession` 注入的是 live roster，认得全员。陈旧只在「老 agent → 新 agent」方向，由 send_mail 兜底（决策 12）收敛。
- **P3a**：先「加孤立 cold agent（无边）」，再「加 agent + 连边」。
- **send note 原语**：作为可选优化，按决策 13 三约束实现；不实现则纯靠 send_mail 兜底（功能正确，认知 on-demand 收敛）。

### send_mail 层兜底（P2/P3 共用，认知收敛主方案）

`handleSendMail`：通过 `canMail` 后，若投递成功，检测「发件方当前 briefing 是否已知 `to`」——实现上不易精确知道 LLM 上下文，故退化为：**任何经 edges 放行但属于运行中新增的边/agent**，在返回串里附一句 informational「note: <to> 可能是你 session 后期新增的 peer，状态 <status>」。这是 best-effort 提示，**不作权限同步机制**（权限只认 `canMail` live config）。

## 测试（TDD，先红后绿）

P1 单测（`control-plane.test.ts` / `mesh.test.ts`）：
- `lazy` agent 启动后状态为 `cold`，无子进程；eager agent 为 `ready`。
- 首封 canMail 放行邮件 → 触发 spawn → 状态 cold→spawning→ready → ready 后发 check_mail drain 提示，agent 经 check_mail 一次读到全部积压。
- **并发首封只 spawn 一次**（用可控 deferred 的 connectionFactory：两封同时到 cold 目标，断言 `spawnAgent`/register 只调一次，两封都进 mailbox 且 drain 后可读）。
- 无边邮件不触发 spawn（canMail 拒）。
- spawn 失败：agent 置 dead + emit event + 给 `from` 发 `[SPAWN FAILED]` 回执 mail（from 可 check_mail 读到）；积压邮件保留。
- register 幂等：dead 后重新 wakeAgent 不重复 `entries.set`/不泄漏 transport。
- spawn timeout：init 永久挂起时 `ensureSpawned` 超时置 dead，不 wedge。
- send_mail fire-and-forget：对 cold 目标发信，工具立即返回（不阻塞到 spawn 完成）。
- router 勾 lazy → 校验拒绝。
- 手动 `wakeAgent` 与首封自动共用锁、不重复 spawn。

P2/P3 单测：
- `addEdge` running 时成功、落盘、`canMail` 立即 true；to=dead 拒绝；重复边幂等/拒绝；steer→router 拒绝。
- 原子写：模拟写中断不留半份 config（temp+rename）。
- `addAgent` 新成员置 cold、可被首封拉起；连边后老 agent send_mail 命中兜底提示。
- `defineMesh` 全量仍 running-throw（安全门不破）。

e2e（`src/web/*.e2e.ts`，Playwright 自带 chromium）：
- Builder 勾选 agent `lazy`；启动 mesh 后该 agent 显示 cold + 「启动」按钮；点击/或对其发信后变 ready。
- 运行中加边：UI 操作后拓扑图出现新边、目标可达。
- 运行中加 agent：新节点出现、cold、可拉起。

门禁：`bunx tsc --noEmit && bun test` 全绿；e2e 全绿；行为变更同步更新对应 `*.e2e.ts`。**只在 DEV 验证**（`--port 10020 --root ~/.agent-mesh-dev`，用完杀掉），绝不碰生产 10010 / `~/.agent-mesh`。

## 影响面（改动文件，按阶段）

P1：
- `src/acp/types.ts`（`AgentConfig.lazy`、`AgentStatus` 加 `cold`、event 联合）
- `src/mesh-validate.ts`（router 不得 lazy）
- `src/control-plane.ts`（`spawnAgent` 抽取、cold 启动分支、`spawning` 锁、`ensureSpawned`、`wakeLazy` + drain、pending 上限、`wakeAgent`）
- `src/mesh-manager.ts` / daemon RPC / `src/web/api.ts` / `src/web/client/store.ts`（`wakeAgent` 通路）
- `src/web/types.ts` + 前端状态徽标 / `MeshBuilder.tsx`（lazy 勾选 + cold 徽标 + 启动按钮）+ `i18n.ts`
- 对应 `*.test.ts` / `*.e2e.ts`

P2：
- `src/mesh.ts`（`addEdge`，内部可变）
- `src/mesh-store.ts`（原子增量写 temp+rename）
- `src/mesh-manager.ts`（`addEdge` dual-write）+ daemon RPC + `control-plane.ts`（`addEdge` + send_mail 兜底提示）
- `src/web/*`（拓扑编辑入口 + 事件刷新）+ 测试

P3：
- `src/mesh.ts`（`addAgent`）
- `src/mesh-manager.ts`（`addAgent` dual-write）+ daemon RPC + `control-plane.ts`（`addAgent` 复用 spawnAgent）
- 可选 system note 原语（决策 13）
- `src/web/*` + 测试

## 为什么删除更危险（佐证「删走重启」，Reviewer 风险表）

| 维度 | 删除引入的不可恢复风险（新增无此问题） |
|---|---|
| in-flight 邮件 | 邮件已在队列/传输中，目标被删后无消费者、无重投目标，永久丢失。 |
| agent 内部状态 | 被删 agent 的内存上下文（待办、reasoning 链、局部状态）不可重建。 |
| 事件环 replay | daemon ring 记录了该 agent 的 send/recv，replay 引用已不存在的 id，需 tombstone。 |
| 边级联清理 | 删 agent 须级联删所有入/出边；删不干净则 `canMail` 仍 true，邮件投黑洞。 |
| 任务链断裂 | Planner→被删 Executor→Reviewer 链中间节点消失，Reviewer 永久挂起。 |
| worktree/资源泄漏 | 进程退出 ≠ worktree 清理，同名 agent 重启冲突。 |
| 重调度 | 被删 agent 未完成工作分散在各处内存，Planner 难以精确重分配。 |

一句话：新增是「扩展状态空间」，旧状态不受影响；删除是「收缩状态空间」，必须证明「所有引用已安全释放」——分布式无共识架构下该证明成本极高，冷重启是最便宜的正确性保证。

## 非目标（YAGNI）

- 删 Agent / 删边（走冷重启）。
- 主动 roster 广播刷新作为强一致机制（仅作可选优化，权限始终靠 canMail）。
- 远程/跨机懒启动的可达性探测与超时治理（本期 cold→spawn 限本地进程）。
- pending 邮件的复杂优先级/调度（FIFO + 硬上限即可）。
