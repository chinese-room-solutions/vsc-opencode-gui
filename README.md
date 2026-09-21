<div align="center">

# VSC OpenCode GUI

**The opencode agent, native in VS Code.**

![VS Code](https://img.shields.io/badge/VS_Code-1.90%2B-0078D4?logo=visualstudiocode&logoColor=white)
![opencode CLI](https://img.shields.io/badge/requires-opencode_CLI-8A2BE2)
![License](https://img.shields.io/badge/license-MIT-green)

<img src="https://github.com/chinese-room-solutions/vsc-opencode-gui/releases/download/media/vsc-opencode-gui.gif" alt="VSC OpenCode GUI demo: session home, chat in an editor tab, mid-turn steering">
</div>

VSC OpenCode GUI puts the [opencode](https://opencode.ai) agent in a native
VS Code chat - an editor tab with command-palette parity. The extension spawns
a headless `opencode serve`, and a self-contained webview UI talks to it over
HTTP/SSE.

## ✨ Features

- **Chat in the editor** - the agent lives in a tab, with a sidebar view and
  session tabs.
- **Projects × sessions home** - every session of every project on one
  screen. Projects rename in place, and sessions from other folders open
  deep-linked.
- **Sub-agents are sessions** - open one from its task chip, steer it, stop
  it, and the parent's turn collects the result.
- **Notifications, visual and sound** - tabs pulse yellow when a session
  waits on you and green when a turn finishes. Chimes cover ready,
  permission, and question events.
- **Steer mid-turn** - a prompt sent while the agent works lands at the next
  step boundary.
- **Peer messages** - messages from other opencode sessions show the
  sender's name and live session title (opencode-plugin-peers).
- **Attachments become real files** - images, PDFs, and documents are saved
  into the workspace before the turn starts, ready for the agent to reuse.
- **Context & cost ring** - live context-window fill, click for the cost and
  token breakdown.
- **Remote-ready** - over SSH, dev containers, WSL, or Codespaces the
  extension runs on the remote host, so the server, files, and sessions
  live where the project is.

## ⌨️ Commands

All commands live under the **`Open Code:`** prefix in the command palette.

| | |
| --- | --- |
| `Open Code: Open in Primary Editor` | Open the chat in an editor tab |
| `Open Code: Toggle Side Panel` | Sidebar view |
| `Open Code: New Session` | Start a session |
| `Open Code: Show History` | Session picker |
| `Open Code: Add Selection to Chat` | Send the editor selection as context |
| `Open Code: Manage Models` | Provider and model picker |
| `Open Code: Show Session Diff` | Working-tree diff of the session |
| `Open Code: Toggle Context Breakdown` | Per-message context panel |
| `Open Code: Open in Terminal` | Terminal bound to the session |
| `Open Code: Restart` | Restart the server, also rebuilds a dead chat tab |

## ⚙️ Settings

| Setting | Default | What it does |
| --- | --- | --- |
| `opencodeGui.port` | `0` | Fixed server port (`0` = random). Changing it resets webview preferences. |
| `opencodeGui.path` | *(empty)* | Full path to the opencode CLI. Empty = use `PATH`. |
| `opencodeGui.exposeToNetwork` | `false` | Pass `--mdns` to the server so other devices can reach it. |
| `opencodeGui.codeGlow` | `false` | Neon-glow rendering for code-block tokens. |
| `opencodeGui.codeCopyModifier` | `alt` | Modifier held to copy small code blocks on click. |
| `opencodeGui.readySound` | `true` | Chime when a turn finishes (1.5 s grace cancels on follow-ups). |
| `opencodeGui.permissionSound` | `true` | Chime on permission asks. |
| `opencodeGui.questionSound` | `true` | Chime on questions. |
| `opencodeGui.stuckToolSeconds` | `300` | Silence before a tool counts as stuck (gates auto-abort). `0` disables. |
| `opencodeGui.stuckAutoAbortSeconds` | `0` | Silence past the stuck threshold before the turn is stopped automatically (sends nothing into the session). `0` disables. Tool rows show elapsed time on hover - ticking while running, the total once settled. |

## 📦 Install

Install from source:

```bash
git clone https://github.com/chinese-room-solutions/vsc-opencode-gui
cd vsc-opencode-gui
make install   # compile, package the .vsix, install - then reload VS Code
```

Requires the [opencode CLI](https://opencode.ai/) where the workspace runs
(remote workspaces: on the remote machine). `make uninstall` removes it.

> ℹ️ On server start, the `oc-attachments` skill is installed into your
> opencode config dir (`~/.config/opencode/skills/`) so every session gets
> attachment reuse. Sub-agent delegation uses the built-in `task` tool.

## 🛠️ Development

```bash
make watch   # recompile on change (auto-installs deps on first run)
```

Then open the repo in VS Code and press `F5` for the Extension Development Host.
Touching only the webview app? `make webview` is the fast path.

### Tests

```bash
make test        # compile + unit suite + real VS Code lifecycle suite
make test-unit   # unit suite only
make test-ui     # Playwright UI pass (builds first)
```

`make test` boots a real VS Code instance for the lifecycle scenarios: server
boot, restart with port reuse, `deactivate()` freeing the port,
uncaught-exception handling, orphan-process checks. Needs Node ≥ 22.5 and
`opencode` + `git` on `PATH`. ~30 s, cleans up after itself.

UI is also exercised in a plain browser via `node scripts/ui-rig.js <dir>
[port]` (real server). See `AGENTS.md` for the verification bar.
