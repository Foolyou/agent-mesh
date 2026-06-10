# Master Assistant Briefing Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Give the external Mesh Assistant a deterministic control-plane briefing so it understands its mesh-management role, tool boundaries, and workspace limits.

**Architecture:** Add a small `buildMasterBriefing()` module for the external assistant only. `MasterAgent.prompt()` prepends that briefing once per master session, without starting a turn in `start()` and without changing ordinary mesh member briefing.

**Tech Stack:** Bun test, TypeScript, existing ACP fake connection tests, existing MCP servers.

---

### Task 1: Master Briefing Text

**Files:**
- Create: `src/master-briefing.ts`
- Create: `src/master-briefing.test.ts`

- [ ] **Step 1: Write failing tests**

Add tests that call `buildMasterBriefing()` and assert substrings for:
- external Mesh Assistant identity
- all seven mesh-control tool names
- reply in the user's language
- destructive operations require `get_mesh` and user confirmation
- not a general-purpose coding assistant
- cwd-confined behavior
- only mesh-control MCP tools may inspect or change meshes

Run: `bun test src/master-briefing.test.ts`
Expected: FAIL because `src/master-briefing.ts` does not exist.

- [ ] **Step 2: Implement minimal briefing builder**

Create `buildMasterBriefing(): string` with concise role, tool, workflow, and boundary instructions. Do not include absolute paths. Do not mention internal implementation paths.

- [ ] **Step 3: Verify targeted tests**

Run: `bun test src/master-briefing.test.ts`
Expected: PASS.

### Task 2: MasterAgent First-Prompt Prepend

**Files:**
- Modify: `src/master-agent.ts`
- Modify: `src/master-agent.test.ts`

- [ ] **Step 1: Write failing tests**

Extend the fake ACP connection to record prompt text and assert:
- first `master.prompt("...")` starts with the briefing and contains the original user text
- second `master.prompt("...")` equals the original user text exactly
- `newSession()` still receives an MCP server named `mesh-control`

Run: `bun test src/master-agent.test.ts`
Expected: FAIL because `MasterAgent.prompt()` does not prepend the briefing.

- [ ] **Step 2: Implement minimal prepend**

Import `buildMasterBriefing()`, add a private `briefed = false`, and wrap text in `MasterAgent.prompt()` only. Reset `briefed` when `start()` creates a fresh session. Do not prompt during `start()`. Do not wrap in `gateway.ts`.

- [ ] **Step 3: Verify targeted tests**

Run: `bun test src/master-agent.test.ts src/master-briefing.test.ts`
Expected: PASS.

### Task 3: Regression Guard For Tool Separation

**Files:**
- Modify: `src/mcp/mesh-services.test.ts` or `src/mcp/mesh-control.test.ts`

- [ ] **Step 1: Write failing/guard tests**

Add MCP tools/list coverage that confirms:
- `mesh-control` includes `update_mesh`
- `mesh-services` does not include `update_mesh`

Run the relevant test files.

- [ ] **Step 2: Implement only if needed**

No production tool registration change is expected. Keep mesh-control and mesh-services separated.

### Task 4: Verification And Review

- [ ] Run `bun test src/master-agent.test.ts src/master-briefing.test.ts src/mcp/mesh-control.test.ts src/mcp/mesh-services.test.ts`
- [ ] Run `bun test`
- [ ] Run `bun run src/web/master-tools.check.ts` on a dev port/root, without production port 10010.
- [ ] Ask review to inspect the diff against the agreed checklist.
- [ ] Commit feature changes.
