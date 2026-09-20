# AGENTS.md

## Project

VS Code extension providing a native opencode UI: the Claude Code extension's
UX model (chat in the editor area, command-palette parity, VS Code theme sync,
keyboard-first) with opencode's capabilities. Nothing is embedded or
patched; we own every route, component, and byte of state.

Architecture:

- The extension spawns and owns `opencode serve` (headless API server) as a
  child process (`src/server/`).
- The UI is our own webview app (`src/webview/`), talking to the server's
  HTTP/SSE API directly.
- `extensionKind: ["workspace"]` — the extension runs on the remote host in
  SSH/Dev Container/WSL/Codespaces. Never assume the local machine: the
  opencode binary, spawned processes, and file paths are all remote-side.

Feature list lives in README.md. Goals, in order: stability, responsiveness,
light weight.

## Stack

- TypeScript, no linter. Extension host compiles with plain `tsc`; the webview
  app (`src/webview/app/`, Preact + signals) type-checks with
  `tsconfig.webview.json` and bundles with esbuild — `npm run compile` runs
  both. Tests: mocha via `@vscode/test-electron` — `npm test` boots a real VS
  Code instance and runs the lifecycle scenarios in `test/`. Needs Node ≥ 22.5
  (node:sqlite) and `opencode` + `git` on PATH.
- UI behavior can't be driven through the harness. Test the app served
  standalone (`node scripts/ui-rig.js <dir> [port]` — real server, plain
  browser) with Playwright: snapshot → click → screenshot every view and
  visual defect; verify each route's state survives F5. **Never send model
  turns from an automated session.** For the real shell, F5 and look.
- Real-shell check without a human F5: throwaway Extension Development Host —
  `Code.exe --user-data-dir <tmp profile> --extensionDevelopmentPath <repo>
  <folder>`, with `ELECTRON_RUN_AS_NODE` unset from env (else Code.exe runs
  as plain node). Disable `security.workspace.trust.enabled` in the profile's
  settings.json (the trust prompt blocks activation); to auto-open the chat,
  seed `{"opencode.panelOpen":true}` under extension key
  `chinese-room-solutions.vsc-opencode-gui` (exact case) in the profile's
  `User/workspaceStorage/<hash>/state.vscdb` and relaunch. Kill only
  processes whose command line matches the profile dir — never by image
  name (the user's own window shares it). The webview DOM is unreachable
  from tools; read its state from screenshots via OCR.
- The top-level agent can be not multimodal (check). Screenshot/visual inspection is
  delegated to a subagent running the vision-capable model
  (zhipuai/glm-5.3-flash), never judged from the top level.

## Working style

- Top-level agent: plan, orchestrate, and review. Make simple changes yourself — a settled, small, contained edit costs more to hand off than to make.
- Delegate the rest, at most 2 subagents at a time: work spanning several files, needing its own exploration, or running long. Each starts cold — hand it the diagnosis, file refs, design, environment setup, and what to verify.
- Subagent: do the work yourself. Never spawn further agents.
- Scale verification to risk: a webview markup/CSS change needs a compile and one look in the Extension Development Host; lifecycle, process, or multi-file changes need `npm test` (and the changed behavior exercised for real when it can't be asserted from the harness).
- Verify a diagnosis against current code before fixing it. One commit per fix.
- Don't spam commits. While nothing is pushed, amend a commit that proved wrong rather than stacking fixups.
- Commit messages: conventional commits (`feat:`/`fix:`/`refactor:`/`chore:`/`docs:`), as short as the change allows — one subject line, a body only for a why the diff doesn't show. No trailers.

## Code quality

- Minimal, direct, maintainable code. Write the minimal thing first; no
  speculative abstractions. Abstractions belong at the existing seams
  (server / webview), not mid-code.
- Follow the existing code style; make breaking changes when needed — nothing
  is published-stable yet.
- Keep comments and docs concise. Don't add comments unless they're necessary.
- A new npm dependency must earn its place: the extension and webview ship as
  bundles, and light weight is a stated goal.
- Revisit your changes before committing: remove what's no longer needed, and
  revert any accumulated change that isn't load-bearing — ship only the code
  that actually fixes the issue.

## VS Code extension rules

- The webview app is browser-context code (its own tsconfig, esbuild bundle):
  no Node built-ins, no imports from the extension host. Extension-host code
  has no DOM.
- Everything created in `activate()` lands in `context.subscriptions`; anything
  with listeners, timers, or child processes implements `vscode.Disposable`.
  `deactivate()` must dispose the server.
- The webview origin derives from the server port, so port churn resets
  webview localStorage. Keep port selection/reuse deliberate; treat
  `globalState`/`workspaceState` keys (`opencode.*`) as a compatibility
  surface.
- Webview HTML: keep the strict CSP pattern; edit `src/webview/` sources and
  templates, never `out/` (generated).
- Target Windows, Linux, macOS, and remotes: use `vscode.Uri` / `path` APIs,
  never string-mangled paths; don't assume a POSIX shell when spawning.
- Prefer VS Code theme CSS variables (`var(--vscode-*)`) in webview content so
  the UI follows the user's theme.

## Async & errors

- No floating promises: `await` every promise, or explicitly handle rejection.
  Event/command callbacks must not reject silently.
- Never swallow errors. Wrap with context and pass up; surface with
  `showErrorMessage` only at command boundaries, with an actionable message.
- Every spawned child process has a defined owner and kill path.

## Conventions

- Use `npm run compile` / `npm run watch`, not ad-hoc `tsc`.
- A user-visible feature, command, or settings change updates README.md in the
  same commit.
- Before calling work done: `npm run compile` is clean and the change was
  exercised in the Extension Development Host. Report what you verified and
  what you couldn't.
