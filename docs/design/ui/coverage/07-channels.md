# 07 · Channels / Feishu + sender approval — coverage

**Scope / routes.** Configure & authorize external channels (Feishu): channel status,
bind a chat→mesh, and approve/revoke per-(channel, openId) senders (dynamic allowlist +
auth-code enrollment). `/channels` (in 管理▾).
**Desktop/mobile.** Desktop: status + binding + sender registry + approvals. Mobile:
read-only status + the pending-sender approve/revoke inbox (the actionable part);
binding/config simplified/deferred to desktop (△).
**Exists vs net-new.** [E] — Feishu channel + provision/sync endpoints ship; sender
enrollment via device-auth allowSenders; [N] redesigned `/channels` surface.
**Sources read.** `../interaction/07-channels.md`; repo: `src/channels/*`,
`channels/feishu.json`, `store.ts` (`getFeishuStatus` `/api/channels/feishu/status`,
`startFeishuProvision`/`getFeishuProvision`/`cancelFeishuProvision`,
`syncFeishuMeshChats` `/sync`, `ensureFeishuMeshChat` `/meshes/<m>/group`), device-auth
allowSenders enrollment (auth-store/auth-codes; see `12`).

## Function / control / action checklist
- **View channel status** [E] — configured/disabled (config on disk; UI shows status).
- **Bind a chat to a mesh** [E] — provision flow (`startFeishuProvision`/poll/cancel); `ensureFeishuMeshChat` create group; `syncFeishuMeshChats`.
- **Pending sender auth-codes → approve/revoke** [E] — dynamic-authz inbox.
- **Revoke an authorized sender** [E] — from the registry.

## Function × state matrix
✓ designed · △ partial/deferred (reason) · N/A not applicable

| Function | empty | loading | populated | error | permission | busy | offline | boundary/scale | desktop | mobile |
|---|---|---|---|---|---|---|---|---|---|---|
| Channel status [E] | ✓("Feishu not configured"+hint) | ✓(fetching→skeleton) | ✓(configured rows) | ✓(config invalid) | N/A | N/A | △(stale; default no-op) | ✓(multiple channels) | ✓ | ✓(read-only) |
| Bind chat→mesh [E] | ✓(no bindings) | ✓ | ✓(binding list) | ✓(bind failed+retry) | △(operator) | ✓(provision in flight; poll) | △(disabled offline) | ✓(N bindings) | ✓ | △(deferred) |
| Pending sender approve/revoke [E] | ✓(no pending) | ✓ | ✓(approve/revoke cards) | ✓(action failed) | ✓(the dynamic-authz inbox) | ✓(approving/revoking) | △(disabled) | ✓(N pending) | ✓ | ✓(inbox) |
| Revoke authorized sender [E] | N/A(none) | ✓ | ✓(registry) | ✓(fail+retry) | △(operator) | ✓(revoking) | △(disabled) | ✓(long registry) | ✓ | △(deferred) |

## Change log / sources read
- 2026-06-21 — created (Phase A commit 3). Sources: `../interaction/07-channels.md`;
  `src/channels/*`, `channels/feishu.json`, `store.ts` feishu endpoints, device-auth
  allowSenders (`12`). p2p-DM folded here per lead #683 assumption 4.
