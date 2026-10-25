<div align="center">

# VSC OpenCode GUI

**The opencode agent, native in VS Code.**

![VS Code](https://img.shields.io/badge/VS_Code-1.90%2B-0078D4?logo=visualstudiocode&logoColor=white)
![opencode CLI](https://img.shields.io/badge/requires-opencode_CLI-8A2BE2)
![License](https://img.shields.io/badge/license-MIT-green)

<img src="https://github.com/chinese-room-solutions/vsc-opencode-gui/releases/download/media/vsc-opencode-gui.gif" alt="VSC OpenCode GUI demo: session home, chat in an editor tab, mid-turn steering">
</div>

VSC OpenCode GUI runs the [opencode](https://opencode.ai) agent in a native
VS Code chat tab. The extension starts a headless `opencode serve` process,
and the chat UI talks to it directly.

## ✨ Features

- **Chat in an editor tab** - also available as a sidebar view. Sessions
  open as tabs.
- **All sessions on one screen** - grouped by project. Rename projects in
  place. Open a session from any folder.
- **Sub-agents are sessions** - open one from its task chip, steer it, or
  stop it. The parent turn collects the result. While sub-agents run, a
  button left of the context ring shows how many. Click it to list them,
  so one buried under later messages stays findable.
- **Notifications, visual and sound** - a tab pulses yellow when a session
  waits on you, green when a turn finishes. Chimes play for finished
  turns, permissions, and questions.
- **Steer mid-turn** - a prompt or command sent while the agent works runs
  after the current step. Hover one for **Revert**. A queued message
  returns to the input box, unsent. A sent prompt rewinds the session: it
  and everything after it leave the transcript, **Redo** brings them back,
  and your next message makes the cut permanent.
- **Stuck turns get a way out** - a model stream can die quietly and leave
  a turn busy forever. After `opencodeGui.stuckToolSeconds` of silence the
  transcript shows the silent time and an **Interrupt** chip.
  `opencodeGui.stuckAutoAbortSeconds` can end the turn for you. A
  sub-agent still working is not silence - the wait runs until it stops.
- **Fast copy** - hold the copy modifier (see `opencodeGui.codeCopyModifier`)
  and click a code block, quote, or inline code to copy it.
- **Peer messages** - messages from other opencode sessions show the
  sender's name and live session title
  ([opencode-peers](https://github.com/chinese-room-solutions/opencode-peers)).
- **Attachments become real files** - images, PDFs, and documents are saved
  into the workspace before the turn starts, ready for the agent to reuse.
- **Context and cost ring** - live context-window fill. Click for the cost
  and token breakdown.

## ⌨️ Commands

All commands live under the **`Open Code:`** prefix in the command palette.

| | |
| --- | --- |
| `Open Code: Open in Primary Editor` | Open the chat in an editor tab |
| `Open Code: Toggle Chat` | Open or close the chat tab (`Ctrl+Esc`) |
| `Open Code: Toggle Side Panel` | Sidebar view |
| `Open Code: New Session` | Start a session |
| `Open Code: Show History` | Session picker |
| `Open Code: Add Selection to Chat` | Send the editor selection as context |
| `Open Code: Add to Chat` | Insert the file's relative path into the chat |
| `Open Code: Manage Models` | Provider and model picker |
| `Open Code: Manage Providers` | Pick which providers the lists show. The plug on a row turns that provider on or off on the server. The shield row goes further: only the checked providers may run anywhere — sub-agent sessions included (opencode 2.x only). |
| `Open Code: Show Session Diff` | Working-tree diff of the session |
| `Open Code: Toggle Context Breakdown` | Per-message context panel |
| `Open Code: Open in Terminal` | Terminal bound to the session |
| `Open Code: Restart` | Restart the server. Also repairs a dead chat tab. |

## ⚙️ Settings

| Setting | Default | What it does |
| --- | --- | --- |
| `opencodeGui.port` | `0` | Fixed server port (`0` = random). Changing it resets the chat's saved settings. |
| `opencodeGui.path` | *(empty)* | Full path to the opencode CLI. Empty = use `PATH`. |
| `opencodeGui.exposeToNetwork` | `false` | Expose the server to the local network. v1 uses `--mdns` (find it at `http://opencode.local:<port>`). v2 listens on all addresses (find it at `http://<LAN-IP>:<port>`). |
| `opencodeGui.codeGlow` | `false` | Neon-glow rendering for code-block tokens. |
| `opencodeGui.codeCopyModifier` | `alt` | Modifier held to copy code blocks and quotes on click. |
| `opencodeGui.readySound` | `true` | Chime when a turn finishes. A follow-up within 1.5 s cancels it. |
| `opencodeGui.permissionSound` | `true` | Chime on permission asks. |
| `opencodeGui.questionSound` | `true` | Chime on questions. |
| `opencodeGui.stuckToolSeconds` | `300` | Seconds of silence before a tool counts as stuck and the Interrupt chip appears. `0` disables. |
| `opencodeGui.stuckAutoAbortSeconds` | `0` | Seconds of silence past the stuck threshold before the turn is stopped for you. Nothing is sent into the session. `0` disables. |

## 📦 Install

Install from source:

```bash
git clone https://github.com/chinese-room-solutions/vsc-opencode-gui
cd vsc-opencode-gui
make install   # compile, package the .vsix, install - then reload VS Code
```

Needs the [opencode CLI](https://opencode.ai/) where the workspace runs -
on the remote machine for remote workspaces. `make uninstall` removes it.

Both server generations work: opencode 1.x (`opencode-ai`, 1.16+) and
opencode 2.x (`@opencode/cli`). The extension detects which one at startup
and uses the matching API.

> ℹ️ On server start the extension installs the `oc-attachments` skill into
> your opencode config dir (`~/.config/opencode/skills/`). It lets every
> session reuse attachments. Sub-agents use the built-in `task` tool.

## 🛠️ Development

```bash
make watch   # recompile on change (auto-installs deps on first run)
```

Then open the repo in VS Code and press `F5` for the Extension Development
Host. Touching only the webview app? `make webview` is the fast path.

### Tests

```bash
make test        # compile + unit suite + real VS Code lifecycle suite
make test-unit   # unit suite only
make test-ui     # Playwright UI pass (builds first)
```

`make test` starts a real VS Code and runs the lifecycle checks: server
boot, restart with port reuse, the port freed on `deactivate()`, uncaught
exceptions, orphaned processes. Needs Node ≥ 22.5 plus `opencode` and
`git` on `PATH`. It takes about 30 s and cleans up after itself.

The UI can also be driven in a plain browser: `node scripts/ui-rig.js <dir>
[port]` serves it against a real server (`OPENCODE_BIN=<path>` picks
another binary, e.g. a 2.x `@opencode/cli` install). See `AGENTS.md`.
