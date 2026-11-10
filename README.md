<div align="center">

# VSC OpenCode GUI

**The opencode agent, native in VS Code.**

![VS Code](https://img.shields.io/badge/VS_Code-1.90%2B-0078D4?logo=visualstudiocode&logoColor=white)
![opencode CLI](https://img.shields.io/badge/requires-opencode_CLI-8A2BE2)
![License](https://img.shields.io/badge/license-MIT-green)

<img src="https://github.com/chinese-room-solutions/vsc-opencode-gui/releases/download/media/vsc-opencode-gui.gif" alt="VSC OpenCode GUI demo: session home, chat in an editor tab, mid-turn steering">
</div>

VSC OpenCode GUI runs the [opencode](https://opencode.ai) agent in native VS
Code chat tabs, backed by a headless `opencode serve` the extension starts and
owns.

## ✨ Features

- **A tab per session** - each conversation is its own editor tab, restored
  after a reload.
- **Sessions side panel** - projects and day-grouped history, with search.
- **Sub-agents are sessions** - open, steer, or stop one from its task chip.
- **Steer mid-turn** - a message sent while the agent works runs after the
  current step. Revert a prompt to rewind the session, and Redo brings it
  back.
- **Notifications** - tab icons show working, waiting on you, and done.
  Chimes mark finished turns, permission asks, and questions.
- **Stuck-turn recovery** - a turn that goes silent gets an Interrupt chip,
  or stops on its own.
- **Attachments as files** - images, PDFs, and documents are saved into the
  workspace for the agent to reuse.
- **Context and cost ring** - live context-window fill. Click it for the
  cost and token breakdown.

## ⌨️ Commands

In the command palette under **`Open Code:`**.

| Command | What it does |
| --- | --- |
| `Open in Primary Editor` | Reveal the last session tab, or start one |
| `Toggle Chat` (`Ctrl+Esc`) | Close the active session tab, or reveal one |
| `Toggle Side Panel` | Show or hide the sessions panel |
| `New Session` | Start a session in a new tab |
| `Show History` | Pick a session to open |
| `Add Selection to Chat` | Send the editor selection as context |
| `Add to Chat` | Insert the file's path into the chat |
| `Manage Models` | Pick the provider and model |
| `Manage Providers` | Show, enable, or (opencode 2.x) restrict providers |
| `Show Session Diff` | The session's working-tree diff |
| `Toggle Context Breakdown` | Per-message context usage |
| `Open in Terminal` | A terminal attached to the session |
| `Copy Session ID`, `Fork Session`, `Rename Session`, `Delete Session` | Act on the active session, also from its tab's right-click menu |
| `Restart` | Restart the server, which also repairs a dead chat tab |

## ⚙️ Settings

| Setting | Default | What it does |
| --- | --- | --- |
| `opencodeGui.path` | *(empty)* | opencode CLI path. Empty uses `PATH` |
| `opencodeGui.port` | `0` | Server port (`0` = random). Changing it resets the chat's saved preferences |
| `opencodeGui.exposeToNetwork` | `false` | Serve on the LAN: `http://opencode.local:<port>` (1.x), `http://<LAN-IP>:<port>` (2.x) |
| `opencodeGui.codeGlow` | `false` | Neon glow on code tokens |
| `opencodeGui.codeCopyModifier` | `alt` | Hold it and click a code block or quote to copy it |
| `opencodeGui.readySound` | `true` | Chime when a turn finishes |
| `opencodeGui.permissionSound` | `true` | Chime on permission asks |
| `opencodeGui.questionSound` | `true` | Chime on questions |
| `opencodeGui.stuckToolSeconds` | `300` | Silence before a turn is marked stuck (`0` = off) |
| `opencodeGui.stuckAutoAbortSeconds` | `0` | Further silence before the turn is stopped for you (`0` = off) |

## 📦 Install

```bash
git clone https://github.com/chinese-room-solutions/vsc-opencode-gui
cd vsc-opencode-gui
make install   # build and install the .vsix, then reload VS Code
```

Needs the [opencode CLI](https://opencode.ai/), 1.x (1.16+) or 2.x, where the
workspace runs: on the remote host for remote workspaces. `make uninstall`
removes the extension.

> ℹ️ On server start the extension installs an `oc-attachments` skill into
> `~/.config/opencode/skills/` so sessions can reuse attachments.

## 🛠️ Development

```bash
make watch      # recompile on change, then F5 for the Extension Development Host
make webview    # rebuild only the webview app
make test       # unit + real VS Code lifecycle suite
make test-unit  # unit suite only
make test-ui    # Playwright UI specs
```

Tests need Node ≥ 22.5 with `opencode` and `git` on `PATH`.
`node scripts/ui-rig.js <dir> [port]` serves the UI in a plain browser against
a real server. More in [AGENTS.md](AGENTS.md).
