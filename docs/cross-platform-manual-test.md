# Cross-platform Manual Test Checklist

This checklist covers macOS and Windows runtime verification for the cross-platform shim work. Linux/WSL unit and e2e gates are covered locally by the builder.

## Commands

1. Run TypeScript checks:

   ```bash
   bunx tsc --noEmit
   ```

2. Run the unit suite, paying special attention to `src/os-shim.test.ts`:

   ```bash
   bun test
   ```

3. Build platform binaries:

   ```bash
   bun build --compile --target=bun-darwin-arm64 src/main.ts --outfile dist/mesh-darwin-arm64
   bun build --compile --target=bun-windows-x64 src/main.ts --outfile dist/mesh-windows-x64.exe
   ```

4. Run the service on the target OS and verify no `ENOENT` occurs from process/port helpers:

   ```bash
   ./dist/mesh up --port 10010
   ./dist/mesh status --port 10010
   ./dist/mesh down --port 10010
   ```

5. Verify the platform updater entrypoint:

   Linux:

   ```bash
   scripts/update.sh
   command -v mesh
   mesh status --port 10010
   ```

   macOS:

   ```bash
   scripts/update-macos.sh
   command -v mesh
   mesh status --port 10010
   ```

   Windows PowerShell:

   ```powershell
   powershell -ExecutionPolicy Bypass -File scripts\update.ps1
   Get-Command mesh
   mesh status --port 10010
   ```

6. Start a mesh, spawn at least one agent, stop it, and confirm the agent process tree is reaped:

   ```bash
   ./dist/mesh
   ```

   In the UI or MCP tools:
   - start a mesh
   - verify an agent reaches ready/working
   - stop the agent or mesh
   - confirm no orphan harness process remains

## Platform Notes

- Linux uses `pgrep -P` for process tree discovery and `ss -ltnp` for port ownership.
- macOS uses `pgrep -P` for process tree discovery and `lsof -nP -iTCP:<port> -sTCP:LISTEN` for port ownership.
- macOS PTY uses BSD `script -q /dev/null sh -c <command>`. BSD `script` argument order differs from util-linux `script`; verify that commands containing spaces execute and that raw logs are not double-written.
- Windows uses `taskkill /T /F /PID` for process tree teardown and `netstat -ano` for port ownership.
- Windows PTY support is v1 fallback only: the PTY backend logs `PTY unavailable on Windows in v1; falling back to non-tty mode.` and runs without a real terminal. Some harness output formatting may differ until ConPTY/node-pty support is implemented in a later task.

## CI Status

`.github/workflows/cross-platform.yml` runs `bunx tsc --noEmit` and `bun test` on Ubuntu, macOS, and Windows. It intentionally skips e2e because browser, daemon, and agent harness setup differs by runner.

## After deps-bump Verification

After dependency bumps, verify each target platform separately:

1. Refresh dependencies and run the core checks:

   ```bash
   bun install
   bunx tsc --noEmit
   bun test
   ```

2. Run e2e suites where the platform has the required browser and harness setup. If Playwright reports missing browser binaries, install them first:

   ```bash
   bunx playwright install
   bun run e2e
   bun run src/web/browser.e2e.ts
   ```

3. Check for platform-specific rendering/runtime differences, especially:
   - `streamdown` markdown rendering changes
   - React 19 hydration or event behavior differences
   - Windows browser font/layout differences in Playwright screenshots
   - Windows PTY fallback output formatting
