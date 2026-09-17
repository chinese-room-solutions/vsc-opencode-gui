import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import * as vscode from "vscode";

export interface PeerInfo {
  id: string;
  name: string;
  title: string;
}

// Watches the opencode-plugin-peers registry so inbound peer cards can name
// their sender: the injected message metadata carries only the endpoint id.
// The plugin rewrites each entry on a 10 s heartbeat (atomic renames), so a
// poll of the same cadence picks up peer and session renames without
// watching the churn.
export class PeerRegistry implements vscode.Disposable {
  private _timer?: NodeJS.Timeout;
  private _snapshot: PeerInfo[] = [];
  private _serialized = "[]";

  constructor(private readonly _onChange: (peers: PeerInfo[]) => void) {}

  start() {
    void this._poll();
    this._timer = setInterval(() => void this._poll(), 10_000);
  }

  dispose() {
    if (this._timer) clearInterval(this._timer);
  }

  get peers(): PeerInfo[] {
    return this._snapshot;
  }

  private async _poll(): Promise<void> {
    const dir = peersDir();
    let files: string[];
    try {
      files = await fs.promises.readdir(dir);
    } catch {
      return; // plugin absent — nothing to name cards with
    }
    const map = new Map<string, PeerInfo>();
    for (const file of files) {
      if (!file.endsWith(".json")) continue;
      try {
        const raw = JSON.parse(
          await fs.promises.readFile(path.join(dir, file), "utf8"),
        ) as {
          endpointId?: unknown;
          instanceId?: unknown;
          name?: unknown;
          title?: unknown;
          activeSessionTitle?: unknown;
        };
        // v2 entries carry endpointId; v1 named it instanceId. Both spell
        // the session title twice (title, activeSessionTitle alias).
        const id =
          typeof raw.endpointId === "string"
            ? raw.endpointId
            : typeof raw.instanceId === "string"
              ? raw.instanceId
              : undefined;
        const name = typeof raw.name === "string" ? raw.name : "";
        const title =
          typeof raw.activeSessionTitle === "string"
            ? raw.activeSessionTitle
            : typeof raw.title === "string"
              ? raw.title
              : "";
        if (!id || !name) continue;
        map.set(id, { id, name, title: title.trim() });
      } catch {
        // mid-rewrite or unreadable — the next tick retries
      }
    }
    const snapshot = [...map.values()].sort((a, b) => a.id.localeCompare(b.id));
    const serialized = JSON.stringify(snapshot);
    if (serialized === this._serialized) return;
    this._serialized = serialized;
    this._snapshot = snapshot;
    this._onChange(snapshot);
  }
}

function peersDir(): string {
  const xdg = process.env.XDG_DATA_HOME?.trim();
  const base = xdg || path.join(os.homedir(), ".local", "share");
  return path.join(base, "opencode-plugin-peers", "peers.d");
}
