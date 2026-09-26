import * as vscode from "vscode";
import * as crypto from "crypto";
import { ChildProcess, spawn, execFile as execFileCb } from "child_process";
import { promisify } from "util";
import * as path from "path";
import * as os from "os";
import * as fs from "fs";
import { ChatHub } from "../webview/ChatHub";
import { serverAuthHeaders, setSpawnedServerPassword } from "./serverAuth";
import { detectDialect, type Dialect } from "./dialect";
import { log } from "../log";

const execFile = promisify(execFileCb);

interface SessionSummary {
  id: string;
  title: string;
  time: { updated: number };
}

// Row of GET /session/{id}/diff — the session's file changes as per-file
// unified patches (live /doc: SnapshotFileDiff; no before/after content).
interface SessionFileDiff {
  file?: string;
  patch?: string;
  additions: number;
  deletions: number;
  status?: "added" | "modified" | "deleted";
}

interface ProviderModel {
  providerID: string;
  modelID: string;
  name: string;
}

interface ProviderInfo {
  id: string;
  name?: string;
  models: Record<
    string,
    { name?: string; capabilities?: { toolcall?: boolean } }
  >;
}

interface ProviderResponse {
  connected: string[];
  all: ProviderInfo[];
}

// Row of GET /api/model (v2): flat catalog entry. `capabilities.tools` is
// the v2 spelling of v1's capabilities.toolcall; `input` lists modalities.
interface V2ModelRow {
  id: string;
  providerID: string;
  name?: string;
  capabilities?: { tools?: boolean; input?: string[]; output?: string[] };
}

// Slash commands the extension adds to every spawned server, injected via
// OPENCODE_CONFIG_CONTENT (merged into the loaded config) so nothing is
// written into the user's config files. A same-named user command wins.
const GUI_COMMANDS = {
  command: {
    todoclear: {
      description: "Clear this session's todo list",
      template:
        "Call the todowrite tool once with an empty todos array to clear this session's todo list, then confirm in one short sentence. Take no other action.",
    },
  },
};

// The v2 engine loads skills only from config directories and skills.paths;
// it misses the external skill directories the v1 engine auto-scans for
// Claude Code compatibility (~/.claude/skills, ~/.agents/skills), so those
// skills never reach a session's system context (they do show on /skill,
// which the v1 service serves). Registering the same directories as
// explicit skill paths loads them under both engines. The env vars that
// disable the v1 scan disable this too; absent directories are skipped
// (the v1 loader logs a warning for a configured-but-missing path).
function externalSkillPaths(): string[] {
  const disabled = (name: string) =>
    ["1", "true", "yes"].includes((process.env[name] ?? "").toLowerCase());
  const paths: string[] = [];
  if (!disabled("OPENCODE_DISABLE_EXTERNAL_SKILLS")) {
    const claude = path.join(os.homedir(), ".claude", "skills");
    if (
      !disabled("OPENCODE_DISABLE_CLAUDE_CODE") &&
      !disabled("OPENCODE_DISABLE_CLAUDE_CODE_SKILLS") &&
      fs.existsSync(claude)
    )
      paths.push(claude);
    const agents = path.join(os.homedir(), ".agents", "skills");
    if (fs.existsSync(agents)) paths.push(agents);
  }
  return paths;
}

// Merge the extension's config additions into the user's OPENCODE_CONFIG_CONTENT
// (both end up as config documents the server merges): the GUI commands plus
// the external skill paths. A same-named user command wins; user skill paths
// are kept ahead of ours.
function withGuiConfig(existing: string | undefined): string {
  const skillPaths = externalSkillPaths();
  const merge = (parsed: Record<string, unknown> | undefined) => {
    const skills = { ...((parsed?.skills as Record<string, unknown>) ?? {}) };
    if (skillPaths.length > 0) {
      const userPaths = Array.isArray(skills.paths)
        ? (skills.paths as unknown[]).filter((p) => typeof p === "string")
        : [];
      skills.paths = [...new Set([...userPaths, ...skillPaths])];
    }
    const merged: Record<string, unknown> = {
      ...GUI_COMMANDS,
      ...parsed,
      command: {
        ...GUI_COMMANDS.command,
        ...((parsed?.command as object | undefined) ?? {}),
      },
    };
    if (skillPaths.length > 0 || parsed?.skills !== undefined)
      merged.skills = skills;
    return JSON.stringify(merged);
  };
  if (!existing) return merge(undefined);
  try {
    return merge(JSON.parse(existing) as Record<string, unknown>);
  } catch {
    // Leave the user's value untouched; the server surfaces its own error.
    return existing;
  }
}

// Skills are discovered at boot, so both installs run BEFORE the server
// spawns; the skill directory honors XDG_CONFIG_HOME like the server's own
// config resolution. Write only when the content differs.
function skillDir(name: string): string {
  const configRoot =
    process.env.XDG_CONFIG_HOME || path.join(os.homedir(), ".config");
  return path.join(configRoot, "opencode", "skills", name);
}

function installSkill(name: string, content: string): void {
  try {
    const dir = skillDir(name);
    fs.mkdirSync(dir, { recursive: true });
    const file = path.join(dir, "SKILL.md");
    let existing = "";
    try {
      existing = fs.readFileSync(file, "utf-8");
    } catch {
      // Not installed yet.
    }
    if (existing !== content) fs.writeFileSync(file, content);
  } catch (err) {
    // A stale skill from a previous install keeps working; surface the rest.
    log.error(`${name} skill install failed:`, err);
  }
}

// The skills are namespaced (oc-*) to keep clear of user skills; remove a
// legacy install of OURS from the unnamespaced era so it can't drift. The
// `name:` frontmatter line is ignored when comparing — it carries the very
// rename being migrated — so a user's own skill under the old name still
// has to match our body text to be touched.
function removeSkillIfOurs(name: string, content: string): void {
  try {
    const stripName = (s: string) => s.replace(/^name:.*$/m, "");
    const file = path.join(skillDir(name), "SKILL.md");
    if (stripName(fs.readFileSync(file, "utf-8")) === stripName(content))
      fs.rmSync(path.dirname(file), { recursive: true, force: true });
  } catch {
    // Missing or unreadable: nothing of ours there.
  }
}

// The async sub-agent delegation skill (oc-task, the marked bash command
// running oc-subagent.js) is gone — the built-in task tool is the only
// delegation path now. Uninstall our leftovers from that era; a user's own
// skill under these names is left alone (ownership is checked by body).
function uninstallSubagentSkill(): void {
  for (const name of ["oc-task", "task"]) {
    try {
      const file = path.join(skillDir(name), "SKILL.md");
      if (fs.readFileSync(file, "utf-8").includes("oc-subagent.js"))
        fs.rmSync(path.dirname(file), { recursive: true, force: true });
    } catch {
      // Not installed: nothing of ours there.
    }
  }
}

// Same pattern for the chat-attachments convention (where the host's
// file snapshots land; see src/attachments.ts).
function installAttachmentsSkill(): void {
  try {
    const content = fs.readFileSync(
      path.join(__dirname, "oc-attachments-skill.md"),
      "utf-8",
    );
    installSkill("oc-attachments", content);
    removeSkillIfOurs("attachments", content);
  } catch (err) {
    log.error("could not read the attachments skill:", err);
  }
}

// The app renders project avatars gray until a color is set (Edit project
// dialog). Assign a random one when we first see a colorless project, so
// projects are distinguishable at a glance. Palette matches the app's.
const PROJECT_COLORS = [
  "orange",
  "yellow",
  "cyan",
  "green",
  "red",
  "pink",
  "blue",
  "purple",
  "gray",
];

// Canonical worktree-path comparison: fold separators (the webview and the
// server speak forward-slash, fsPath is backslash on Windows) and the
// Windows drive letter's case (the OS canonicalizes it; NTFS/APFS
// otherwise preserve case). Drive first: a root "c:\" loses its slash to
// the trailing strip before the letter rule fires.
export function normWorktree(p: string): string {
  return p
    .replace(/\\/g, "/")
    .replace(/^([a-z]):\//i, (m) => m.toUpperCase())
    .replace(/\/+$/, "");
}

// The single owner of the fallback port pick: the webview origin (and its
// localStorage) is port-derived, so every spawn site must move the same way.
export function randomPort(): number {
  return Math.floor(Math.random() * (65535 - 16384 + 1)) + 16384;
}

// Live (heartbeat < 90s) server leases across all windows.
function leaseEntries(
  context: vscode.ExtensionContext,
): { port: number; session: string; ts: number }[] {
  const raw = context.globalState.get<unknown[]>("opencode.serverSessions") ?? [];
  return raw.filter(
    (e): e is { port: number; session: string; ts: number } =>
      !!e &&
      typeof e === "object" &&
      typeof (e as { port?: unknown }).port === "number" &&
      typeof (e as { session?: unknown }).session === "string" &&
      typeof (e as { ts?: unknown }).ts === "number" &&
      Date.now() - (e as { ts: number }).ts < 90_000,
  );
}

export class ServerManager {
  private serverProcess: ChildProcess | undefined;
  private bootTimer: NodeJS.Timeout | undefined;
  private disposed = false;
  private bootedAt = 0;
  private _apiBaseUrl: string | undefined;
  private _spawnedPort: number | undefined;
  private _leaseTimer: NodeJS.Timeout | undefined;
  private _leaseCtx: vscode.ExtensionContext | undefined;
  private _markReady!: () => void;
  // Dialect of the attached server (probe-based, works for spawn and
  // attach); undefined until detected.
  private _dialect: Dialect | undefined;
  // Set by the owner: called when the server dies unexpectedly AFTER a
  // successful boot (crash, OOM kill). The owner decides whether to respawn.
  onUnexpectedExit: (() => void) | undefined;
  // Resolves once startup has either produced an API base URL or failed;
  // lets callers issued right at start (lazy spawn) wait out the boot.
  readonly ready: Promise<void> = new Promise((r) => (this._markReady = r));

  async start(
    hub: ChatHub,
    context: vscode.ExtensionContext,
    port: number,
    exposeToNetwork: boolean = false,
    opencodePath: string = "",
  ): Promise<void> {
    const cwd = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;

    if (!cwd) {
      hub.setError("No workspace folder open.", false);
      this._markReady();
      return;
    }

    // A fresh start may attach to someone else's server — drop any
    // password a previous spawn of ours registered.
    setSpawnedServerPassword(undefined);

    // Persist the port so we can reuse it next time (preserves webview
    // localStorage, which is tied to the origin).
    void context.globalState.update("opencode.serverPort", port);

    uninstallSubagentSkill();
    installAttachmentsSkill();

    // Attach to a booted server: everything (API relaying and the event
    // pump) goes through the extension host, so one local base url covers
    // it — the webview gets the same url only as its ready flag.
    const attach = async (serverUrl: string) => {
      // The host runs where the server runs (extensionKind: workspace), so
      // localhost is always correct — and it is all anyone needs now: the
      // webview origin is opaque, so the server's CORS blocked every direct
      // call; AppHost relays for it instead.
      const parsed = new URL(serverUrl);
      this._apiBaseUrl = `http://localhost:${parsed.port}`;
      this._dialect = await detectDialect(
        this._apiBaseUrl,
        serverAuthHeaders(),
      );
      log.info(
        `server attached on port ${parsed.port} (dialect ${this._dialect})`,
      );
      this._markReady();
      this.ensureProjectColor(this._apiBaseUrl).catch((err) =>
        log.warn("project color assignment failed:", err),
      );
      hub.setServerUrl(this._apiBaseUrl);
      this._startLease(context, Number(parsed.port));
    };

    // Check if a server from the previous session is still running on this
    // port. Reuse it only if it provably serves this workspace — a port can
    // belong to a server started for another folder (or before a folder
    // rename), and attaching to it shows that project's stale data.
    const existingUrl = `http://localhost:${port}`;
    if (await this.isServerAlive(existingUrl)) {
      if (await this.servesWorkspace(existingUrl, cwd)) {
        await attach(existingUrl);
        return;
      }
      // Foreign server owns the stored port — spawn ours on a fresh one.
      port = randomPort();
      void context.globalState.update("opencode.serverPort", port);
    }

    try {
      const opencodeCommand = opencodePath.trim() || "opencode";

      // shell:true concatenates file+args unquoted — a configured path with
      // spaces must carry its own quotes for cmd.exe.
      const commandLine =
        process.platform === "win32" && /\s/.test(opencodeCommand)
          ? `"${opencodeCommand}"`
          : opencodeCommand;

      // v2 serves are password-protected BY DEFAULT; v1 only when the env
      // already says so. Sniff the CLI version once so a spawned v2 child
      // gets a password we generate (v1 spawns stay open exactly as
      // before — other windows and clients attach to them without it).
      // Version strings: v1 prints bare "1.18.30", v2 "opencode v2.0.18".
      let spawnPassword: string | undefined;
      try {
        const ver = await execFile(commandLine, ["--version"], {
          timeout: 5000,
          // Same resolution rule as the serve spawn below.
          shell: process.platform === "win32",
        });
        if (/^opencode\s+v?2\./m.test(`${ver.stdout}${ver.stderr}`))
          spawnPassword = crypto.randomBytes(24).toString("hex");
      } catch {
        // Unversioned binary: assume v1 (a misdetected v2 child prints a
        // password we never learn and every call 401s — but a binary whose
        // --version fails won't serve either).
      }
      setSpawnedServerPassword(spawnPassword);

      // A pre-boot exit is nearly always the port (opencode exits 1 with
      // "ServeError" when the bind fails), not the install. Keep the child's
      // output so the failure says what happened, and retry once on a fresh
      // port — the stored one can be squatted by something /api/health can't
      // see, which would fail every reload identically.
      const attempt = (port: number, retry: boolean): void => {
        const args = ["serve", "--port", port.toString()];
        if (exposeToNetwork) {
          args.push("--mdns");
        }

        this.serverProcess = spawn(commandLine, args, {
          cwd,
          // Windows: bare "opencode" won't resolve to opencode.cmd without a
          // shell (Node does no PATHEXT resolution on spawn).
          shell: process.platform === "win32",
          windowsHide: true,
          stdio: "pipe",
          env: {
            ...process.env,
            OPENCODE_CALLER: "vscode",
            ...(spawnPassword
              ? { OPENCODE_SERVER_PASSWORD: spawnPassword }
              : {}),
            OPENCODE_CONFIG_CONTENT: withGuiConfig(
              process.env.OPENCODE_CONFIG_CONTENT,
            ),
          },
        });
        this._spawnedPort = port;

        let resolved = false;
        let output = "";
        this.bootedAt = Date.now();

        const onUrl = (url: string) => {
          if (resolved || this.disposed) return;
          resolved = true;
          if (this.bootTimer) clearTimeout(this.bootTimer);
          this.bootTimer = undefined;
          void attach(url);
        };

        // Parse stdout/stderr for the server URL, and keep the tail for the
        // exit path — the generic exit code alone reads as a broken install.
        const handleOutput = (data: Buffer) => {
          const text = data.toString();
          output = (output + text).slice(-2000);
          if (resolved) return;
          const match = text.match(/https?:\/\/[^\s]+/);
          if (match) onUrl(match[0]);
        };

        this.serverProcess.stdout?.on("data", handleOutput);
        this.serverProcess.stderr?.on("data", handleOutput);

        this.serverProcess.on("error", (err) => {
          if (resolved) return;
          resolved = true;
          this._markReady();
          if ((err as NodeJS.ErrnoException).code === "ENOENT") {
            if (opencodePath.trim()) {
              hub.setError(
                "Could not find the configured <code>opencode.path</code> executable.",
              );
            } else {
              hub.setError("Could not find the <code>opencode</code> CLI.");
            }
          } else {
            hub.setError(`Failed to start server: ${err.message}`);
          }
        });

        this.serverProcess.on("exit", (code) => {
          if (this.disposed) return;
          if (!resolved) {
            resolved = true;
            if (this.bootTimer) clearTimeout(this.bootTimer);
            this.bootTimer = undefined;
            const exit = code === null ? "a signal" : `code ${code}`;
            log.error(`server exited with ${exit} before booting:`, output.trim());
            if (retry) {
              const fresh = randomPort();
              void context.globalState.update("opencode.serverPort", fresh);
              attempt(fresh, false);
              return;
            }
            this._markReady();
            const clean = output.replace(/\x1b\[[0-9;]*m/g, "");
            const reason = clean.match(/Error:.*$/m)?.[0]?.trim();
            hub.setError(
              `OpenCode server exited with ${exit}${
                reason ? `: ${reason}` : ". Check that your opencode installation is working."
              }`,
            );
            return;
          }
          // Died after a successful boot. A young process means a broken
          // install (respawning would loop forever) — surface the error; a
          // long-lived one likely died of something transient — let the owner
          // respawn.
          if (Date.now() - this.bootedAt > 60_000) this.onUnexpectedExit?.();
          else
            hub.setError(
              "The OpenCode server exited shortly after starting. Check that your opencode installation is working.",
            );
        });

        // Fallback: with no URL in stdout after 5s, probe the expected URL.
        // A failed probe reschedules — a slow boot heals; a dead child is
        // surfaced by the exit handler instead of a dead port being attached.
        const probeBoot = () => {
          const url = `http://localhost:${port}`;
          void this.isServerAlive(url).then((alive) => {
            if (this.disposed || resolved) return;
            if (alive) onUrl(url);
            else this.bootTimer = setTimeout(probeBoot, 5000);
          });
        };
        this.bootTimer = setTimeout(probeBoot, 5000);
      };

      attempt(port, true);
    } catch (err) {
      hub.setError(
        `Failed to start the OpenCode server: ${
          err instanceof Error ? err.message : String(err)
        }`,
      );
      this._markReady();
    }
  }

  // Tears the server down and RESOLVES only when the process is gone and
  // the ports are actually free — restarting against a still-live child
  // hits EADDRINUSE and kills the new spawn. Tree-kill on Windows: the
  // child was spawned through a shell, and kill() would only kill the
  // shell, orphaning opencode.
  async dispose(): Promise<void> {
    this.disposed = true;
    if (this.bootTimer) clearTimeout(this.bootTimer);
    this.bootTimer = undefined;
    setSpawnedServerPassword(undefined);

    // Kill-by-port only when this manager spawned the server, or no other
    // live window still leases it (another window may have attached to ours).
    let sweep = this._spawnedPort !== undefined;
    if (this._leaseTimer) {
      clearInterval(this._leaseTimer);
      this._leaseTimer = undefined;
    }
    if (this._leaseCtx) {
      const live = leaseEntries(this._leaseCtx);
      const session = vscode.env.sessionId;
      void this._leaseCtx.globalState.update(
        "opencode.serverSessions",
        live.filter((e) => e.session !== session),
      );
      const port = this.serverPort;
      if (port && live.some((e) => e.session !== session && e.port === port)) {
        sweep = false;
      }
    }

    const proc = this.serverProcess;
    this.serverProcess = undefined;

    // Windows: the child was spawned through a shell, so kill() only kills
    // the shell — its exit event fires and opencode survives orphaned.
    // `serve` also spawns a detached worker of its own that survives a
    // pid-tree kill. Kill the tree AND sweep by the port, which is unique
    // to this server.
    const port = this.serverPort;
    if (proc?.pid && process.platform === "win32") {
      // Fire-and-forget pid-tree kill; without the handler a spawn error
      // (EMFILE, missing taskkill) would crash the extension host.
      spawn("taskkill", ["/pid", String(proc.pid), "/T", "/F"], {
        windowsHide: true,
        stdio: "ignore",
      }).on("error", (e) =>
        log.error("taskkill failed:", e),
      );
      if (port && sweep) {
        // Awaited: a restart respawns on this same port immediately after
        // dispose() resolves — a lingering sweep would kill it.
        try {
          await execFile(
            "powershell",
            [
              "-NoProfile",
              "-c",
              `Get-CimInstance Win32_Process -Filter "Name='opencode.exe'" | ` +
                `Where-Object { $_.CommandLine -like '*serve --port ${port}*' } | ` +
                `ForEach-Object { Stop-Process -Id $_.ProcessId -Force }`,
            ],
            { windowsHide: true, timeout: 5000 },
          );
        } catch (err) {
          log.error("port sweep failed:", err);
        }
      }
    }

    const procGone = new Promise<void>((resolve) => {
      if (!proc || proc.exitCode !== null || proc.signalCode !== null) {
        resolve();
        return;
      }
      proc.once("exit", () => resolve());
      const force = setTimeout(() => {
        if (proc.exitCode === null && proc.signalCode === null)
          proc.kill("SIGKILL");
      }, 3000);
      proc.once("exit", () => clearTimeout(force));
    });

    if (proc?.exitCode === null && proc.signalCode === null)
      proc.kill();
    if (port && sweep && process.platform !== "win32") {
      try {
        await execFile("pkill", ["-f", `serve --port ${port}`], {
          timeout: 5000,
        });
      } catch {
        // pkill exits 1 when nothing matched — the common case.
      }
    }

    await procGone;
  }

  // Windows can attach to a server another window spawned (the stored port
  // is global). Lease it in globalState so dispose only sweeps the port when
  // the last live window closes: a heartbeat keeps this window's entry
  // fresh; entries older than the threshold (crashed hosts) are pruned.
  private _startLease(context: vscode.ExtensionContext, port: number): void {
    this._leaseCtx = context;
    const session = vscode.env.sessionId;
    const write = () => {
      const live = leaseEntries(context).filter((e) => e.session !== session);
      void context.globalState.update("opencode.serverSessions", [
        ...live,
        { port, session, ts: Date.now() },
      ]);
    };
    write();
    this._leaseTimer = setInterval(write, 30_000);
    this._leaseTimer.unref?.();
  }

  // Port of the spawned `opencode serve` (0/undefined before boot, or when
  // a foreign server was attached). Test surface.
  get serverPort(): number | undefined {
    return this._apiBaseUrl
      ? parseInt(new URL(this._apiBaseUrl).port, 10)
      : undefined;
  }

  // GET /session — all sessions for the server's project.
  async listSessions(): Promise<SessionSummary[] | undefined> {
    await this.ready;
    if (this._dialect === "v2") {
      const page = await this._request<{ data?: SessionSummary[] }>(
        "GET",
        "/api/session?limit=400",
      );
      return page?.data;
    }
    return this._request<SessionSummary[]>("GET", "/session");
  }

  // GET /session/{id}/diff — the session's file changes as unified patches.
  async sessionDiff(id: string): Promise<SessionFileDiff[] | undefined> {
    await this.ready;
    if (this._dialect === "v2") {
      const page = await this._request<{ data?: SessionFileDiff[] }>(
        "GET",
        `/api/session/${id}/diff`,
      );
      return page?.data;
    }
    return this._request<SessionFileDiff[]>("GET", `/session/${id}/diff`);
  }

  // GET /provider — the raw catalog (all known providers + the connected
  // ids), with `connected` narrowed to providers the config names (provider
  // blocks plus the default model's provider): /provider marks every catalog
  // provider whose env var exists as connected, so one API key lights up
  // several lookalike storefronts the user never configured. The Manage
  // Models quick pick and syncModelAgents both consume this. On v2 the
  // catalog is assembled from /api/provider (connected rows — no models)
  // plus the flat /api/model catalog (no `limit` param: the route returns
  // an empty list when handed one).
  async providerCatalog(): Promise<ProviderResponse | undefined> {
    await this.ready;
    if (this._dialect === "v2") {
      const [providers, models] = await Promise.all([
        this._request<{ data?: { id?: string }[] }>("GET", "/api/provider"),
        this._request<{ data?: V2ModelRow[] }>("GET", "/api/model"),
      ]);
      if (!providers && !models) return undefined;
      const all: ProviderInfo[] = [];
      const byId = new Map<string, ProviderInfo>();
      for (const m of models?.data ?? []) {
        if (!m?.id || !m.providerID) continue;
        let provider = byId.get(m.providerID);
        if (!provider) {
          provider = { id: m.providerID, models: {} };
          byId.set(m.providerID, provider);
          all.push(provider);
        }
        provider.models[m.id] = {
          name: m.name ?? m.id,
          capabilities: { toolcall: m.capabilities?.tools === true },
        };
      }
      return {
        connected: (providers?.data ?? [])
          .map((r) => r.id)
          .filter((id): id is string => !!id),
        all,
      };
    }
    const [catalog, config] = await Promise.all([
      this._request<ProviderResponse>("GET", "/provider"),
      this._request<{ model?: string; provider?: Record<string, unknown> }>(
        "GET",
        "/config",
      ),
    ]);
    if (!catalog) return undefined;
    const named = new Set(Object.keys(config?.provider ?? {}));
    const def = config?.model?.split("/")[0];
    if (def) named.add(def);
    if (named.size === 0) return catalog;
    return {
      ...catalog,
      connected: catalog.connected.filter((c) => named.has(c)),
    };
  }

  // GET /provider — configured connected providers with their
  // toolcall-capable models (see providerCatalog for the narrowing). Polls
  // until at least one provider is connected (or timeout).
  async listProviders(): Promise<ProviderModel[] | undefined> {
    await this.ready;
    const deadline = Date.now() + 15000;
    while (Date.now() < deadline) {
      const data = await this.providerCatalog();
      if (data && data.connected && data.connected.length > 0) {
        const models: ProviderModel[] = [];
        for (const provider of data.all ?? []) {
          if (!data.connected.includes(provider.id)) continue;
          for (const [mid, m] of Object.entries(provider.models ?? {})) {
            if (m.capabilities?.toolcall) {
              models.push({
                providerID: provider.id,
                modelID: mid,
                name: m.name ?? mid,
              });
            }
          }
        }
        return models;
      }
      await new Promise((r) => setTimeout(r, 1000));
    }
    return undefined;
  }

  // Write a subagent markdown file per connected model to
  // ~/.config/opencode/agents/ so the server exposes every model as a
  // callable subagent. Returns true if files were added/changed/removed
  // and the server needs a restart to pick them up.
  async syncModelAgents(): Promise<boolean> {
    const models = await this.listProviders();
    if (!models) return false;

    const agentsDir = path.join(os.homedir(), ".config", "opencode", "agents");
    try {
      await fs.promises.mkdir(agentsDir, { recursive: true });
    } catch {
      return false;
    }

    // Read existing oc-model- files.
    let existing: string[] = [];
    try {
      existing = (await fs.promises.readdir(agentsDir)).filter((f) =>
        f.startsWith("oc-model-"),
      );
    } catch {
      existing = [];
    }

    // Build desired file set: filename → content.
    const desired = new Map<string, string>();
    const usedNames = new Set<string>();

    for (const m of models) {
      const base = m.name
        .toLowerCase()
        .replace(/\(.*?\)/g, "")
        .replace(/[^a-z0-9]+/g, "-")
        .replace(/^-+|-+$/g, "");
      let file = `oc-model-${base}.md`;
      if (usedNames.has(base)) file = `oc-model-${m.providerID}-${base}.md`;
      usedNames.add(base);

      const modelRef = `${m.providerID}/${m.modelID}`;
      desired.set(
        file,
        `---\ndescription: Run tasks using ${m.name}\nmode: subagent\nmodel: ${modelRef}\n---\nYou are a subagent. Complete the assigned task.\n`,
      );
    }

    let changed = false;

    // Write new/changed files.
    for (const [file, content] of desired) {
      const fp = path.join(agentsDir, file);
      try {
        const prev = await fs.promises.readFile(fp, "utf8");
        if (prev !== content) {
          await fs.promises.writeFile(fp, content);
          changed = true;
        }
      } catch {
        await fs.promises.writeFile(fp, content);
        changed = true;
      }
    }

    // Remove stale files.
    for (const file of existing) {
      if (!desired.has(file)) {
        try {
          await fs.promises.unlink(path.join(agentsDir, file));
          changed = true;
        } catch {
          // best effort
        }
      }
    }

    return changed;
  }

  private async _request<T>(
    method: string,
    path: string,
  ): Promise<T | undefined> {
    if (!this._apiBaseUrl) return undefined;
    try {
      // A hung (not failed) server connection must not wedge the command
      // surface (same cap as the webview relay).
      const res = await fetch(`${this._apiBaseUrl}${path}`, {
        method,
        signal: AbortSignal.timeout(10_000),
        headers: serverAuthHeaders(),
      });
      if (!res.ok) return undefined;
      return (await res.json()) as T;
    } catch {
      return undefined;
    }
  }

  // True only when the server behind baseUrl reports the given folder as
  // its current project's worktree (or a sandbox of it). A server running
  // outside any git repo reports the "global" project (worktree "/") and
  // never matches — safer to spawn fresh than attach to the wrong thing.
  // v2 has no /project/current: match the folder against the /api/project
  // list's `canonical` (same normWorktree fold).
  private async servesWorkspace(baseUrl: string, cwd: string): Promise<boolean> {
    const target = normWorktree(cwd);
    try {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 1000);
      const res = await fetch(`${baseUrl}/project/current`, {
        signal: controller.signal,
        headers: serverAuthHeaders(),
      });
      clearTimeout(timeout);
      // v1-only routes answer GET with 200 + SPA HTML on v2 — only a JSON
      // reply is /project/current.
      if (
        res.ok &&
        (res.headers.get("content-type") ?? "").includes("application/json")
      ) {
        const project = (await res.json()) as {
          worktree?: string;
          sandboxes?: string[];
        };
        if (project.worktree && normWorktree(project.worktree) === target)
          return true;
        return (project.sandboxes ?? []).some((s) => normWorktree(s) === target);
      }
      const list = await fetch(`${baseUrl}/api/project`, {
        signal: AbortSignal.timeout(2000),
        headers: serverAuthHeaders(),
      });
      if (
        list.ok &&
        (list.headers.get("content-type") ?? "").includes("application/json")
      ) {
        const projects = (await list.json()) as {
          canonical?: string;
          sandboxes?: string[];
        }[];
        return (projects ?? []).some(
          (p) =>
            (p.canonical && normWorktree(p.canonical) === target) ||
            (p.sandboxes ?? []).some((s) => normWorktree(s) === target),
        );
      }
      return false;
    } catch {
      return false;
    }
  }

  // Give the server's current project a random avatar color if it has none.
  // No-ops for the global (folderless) project and for projects the user
  // already colored. v2 has no /project/current (the SPA fallback answers
  // 200 + HTML) and its project PATCH is unverified — no-op there.
  private async ensureProjectColor(baseUrl: string): Promise<void> {
    if (this._dialect === "v2") return;
    const signal = () => AbortSignal.timeout(10_000);
    const res = await fetch(`${baseUrl}/project/current`, {
      signal: signal(),
      headers: serverAuthHeaders(),
    });
    if (
      !res.ok ||
      !(res.headers.get("content-type") ?? "").includes("application/json")
    )
      return;
    const project = (await res.json()) as { id?: string; worktree?: string };
    if (!project.id || project.id === "global" || !project.worktree) return;
    // /project/current is cached at server boot; the list reflects PATCHes.
    const list = (await (
      await fetch(`${baseUrl}/project`, { signal: signal(), headers: serverAuthHeaders() })
    ).json()) as {
      id: string;
      icon?: { color?: string };
    }[];
    if (list.find((p) => p.id === project.id)?.icon?.color) return;
    const color =
      PROJECT_COLORS[Math.floor(Math.random() * PROJECT_COLORS.length)];
    await fetch(
      `${baseUrl}/project/${project.id}?directory=${encodeURIComponent(project.worktree)}`,
      {
        method: "PATCH",
        headers: { "Content-Type": "application/json", ...serverAuthHeaders() },
        body: JSON.stringify({ icon: { color } }),
        signal: signal(),
      },
    );
  }

  // Quick health check to see if a server from a previous session is still
  // alive. GET /api/health (v1); a v2 server 404s it, so fall back to an
  // authed session list probe — 2xx proves a v1 or v2 server, and 401 still
  // proves an opencode v2 is behind the port (it is password-protected by
  // default; a foreign one without our password is alive but unattachable,
  // which servesWorkspace then rejects). A 200 HTML body (the SPA fallback
  // for unknown paths) is not a healthy opencode server.
  private async isServerAlive(url: string): Promise<boolean> {
    try {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 1000);
      const res = await fetch(`${url}/api/health`, {
        signal: controller.signal,
        headers: serverAuthHeaders(),
      });
      clearTimeout(timeout);
      if (res.ok) {
        const body = (await res.json()) as { healthy?: boolean };
        return body.healthy === true;
      }
      if (res.status === 404) {
        const probe = await fetch(`${url}/api/session?limit=1`, {
          signal: AbortSignal.timeout(1000),
          headers: serverAuthHeaders(),
        });
        return probe.status === 401 || probe.ok;
      }
      return false;
    } catch {
      return false;
    }
  }
}
