import { useState, useEffect, useRef } from "preact/hooks";
import type { JSX } from "preact";
import { attachAllowed, attachMime, extOf, findFiles, isText, sniffsText, type SessionStatus } from "../api";
import { postToHost, openFile, openExternal } from "../host";
import { atTrigger } from "../mentions";
import {
  addComposerFiles,
  agents,
  attachInputs,
  commands,
  composerFiles,
  composerFilesFor,
  composerInsert,
  currentDir,
  dropDraft,
  getDraft,
  messagesBySession,
  putDraft,
  queueCommand,
  requestAttachmentSnapshot,
  runSlashCommand,
  sendPrompt,
  setSendError,
  sessions,
  stopSession,
} from "../store";
import { AgentPicker, ModelPicker, VariantPicker } from "./Pickers";
import { imgPreview, openLightbox } from "./Lightbox";
import { ArrowUpIcon, PlusIcon, StopIcon } from "../icons";

// Slash entries the app runs itself (runSlashCommand intercepts them) —
// /compact is a client call to the summarize endpoint, not a server command.
const BUILTIN_COMMANDS = [
  { name: "compact", description: "Summarize the conversation to free context" },
];

// File attach from paste/drop, mirroring the opencode web app: images, pdf,
// audio/video and text-ish files become data-URI file parts; the 10 MB cap
// keeps a paste from wedging the postMessage relay. attachMime is the gate
// and the payload type — the data URL's own prefix gets restamped, since
// Windows gives text files an empty blob type and FileReader then writes
// "application/octet-stream". Files the name/type layers can't classify
// get a content sniff of their first 8 KB (sniffsText). attachAllowed adds
// the active model's input modalities on top.
const EXT_FROM_MIME: Record<string, string> = {
  "image/png": "png",
  "image/jpeg": "jpg",
  "image/gif": "gif",
  "image/webp": "webp",
  "application/pdf": "pdf",
  "text/plain": "txt",
  "audio/mpeg": "mp3",
  "audio/wav": "wav",
  "audio/ogg": "ogg",
  "audio/mp4": "m4a",
  "audio/flac": "flac",
  "audio/aac": "aac",
  "video/mp4": "mp4",
  "video/webm": "webm",
  "video/quicktime": "mov",
  "video/x-matroska": "mkv",
};
const MAX_FILE_BYTES = 50 * 1024 * 1024;

const readDataUrl = (f: File) =>
  new Promise<string>((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => resolve(String(r.result));
    r.onerror = () => reject(r.error);
    r.readAsDataURL(f);
  });

let pasteSeq = 0;

// Turn pasted/dropped Files into composer chips (data-URI attachments).
// Refused files are counted per reason and surfaced once through sendError;
// the rest attach to the composer that took the action. The byte cap guards
// the webview→host relay (the data URI rides it inside the prompt body) —
// larger files still attach through the + picker, which sends a file:// url
// the server reads from disk.
async function attachFiles(
  sessionId: string | undefined,
  files: Iterable<File>,
): Promise<void> {
  const key = sessionId ?? "draft";
  const input = attachInputs(sessionId);
  const added: { uri: string; name: string }[] = [];
  const reasons: [label: string, n: number][] = [];
  const refuse = (label: string) => {
    const row = reasons.find(([l]) => l === label);
    if (row) row[1]++;
    else reasons.push([label, 1]);
  };
  for (const f of files) {
    let mime = attachMime(f.name, f.type);
    // Unclassified name/type: sniff the first 8 KB — valid UTF-8 text
    // rides as text/plain, binaries stay refused. A failed prefix read
    // just leaves the file unclassified (skipped below).
    if (mime === undefined) {
      try {
        if (sniffsText(new Uint8Array(await f.slice(0, 8192).arrayBuffer())))
          mime = "text/plain";
      } catch {}
    }
    if (!mime) {
      refuse("unsupported type");
      continue;
    }
    if (f.size > MAX_FILE_BYTES) {
      refuse("over 50 MB - use + for large files");
      continue;
    }
    if (!attachAllowed(mime, input)) {
      refuse("not supported by this model");
      continue;
    }
    const name =
      f.name || `paste-${++pasteSeq}.${EXT_FROM_MIME[mime] ?? "bin"}`;
    // A read failure (permissions, vanished file) must not reject: the
    // promise is discarded by callers and a rejection takes the whole view
    // down via the unhandledrejection crash card.
    let uri: string;
    try {
      uri = (await readDataUrl(f)).replace(/^data:[^;,]*/, `data:${mime}`);
    } catch {
      refuse("unreadable");
      continue;
    }
    // Non-image attachments snapshot to disk before the chip exists: the
    // chip is click-to-open from birth and the prompt carries a file://
    // url the server reads directly (no base64 through the relay). Images
    // keep their data URI — the chip row and lightbox render it directly.
    // A timeout or error keeps the data URI (inert but sendable).
    if (!mime.startsWith("image/")) {
      uri = (await requestAttachmentSnapshot(key, uri, name, mime)) ?? uri;
    }
    added.push({ uri, name });
  }
  if (added.length) addComposerFiles(key, added);
  if (reasons.length) {
    const skipped = reasons.reduce((n, [, c]) => n + c, 0);
    setSendError(
      `${skipped} file${skipped > 1 ? "s" : ""} not attached (${reasons
        .map(([l, n]) => (n > 1 ? `${n} ${l}` : l))
        .join(", ")}).`,
    );
  }
}

// Composer: one bordered card — autosizing textarea on top, chip row (attach,
// model, variant, agent) and the send button inside its bottom edge. Enter
// sends, Shift+Enter is a newline; Esc (no dropdown open) blurs and hands
// focus back to the editor group. While the turn runs the send arrow becomes
// a stop square, and Enter instead steers: the server queues the message and
// delivers it as the next turn the moment the current one ends.
export function Composer(props: { sessionId?: string; status?: SessionStatus }) {
  const ref = useRef<HTMLTextAreaElement>(null);
  const draftKey = props.sessionId ?? "draft";
  // Attachment chips are this composer's own — a global list would follow
  // you into every tab you switch to.
  const files = composerFilesFor(draftKey);
  const busy = props.status?.type === "busy" || props.status?.type === "retry";
  // The send button mirrors the input: while a turn runs, an empty field
  // offers Stop, any text swaps it for Send — a busy session queues the
  // message into the running turn, so sending stays one click away.
  const [hasText, setHasText] = useState(
    () => getDraft(draftKey).trim().length > 0,
  );
  const syncText = (el: HTMLTextAreaElement) =>
    setHasText(el.value.trim().length > 0);
  // Open while the text is a bare "/query" — closed once a space (args)
  // follows. `slashIndex` is the highlighted match.
  const [slashQuery, setSlashQuery] = useState<string | undefined>();
  const [slashIndex, setSlashIndex] = useState(0);
  // Open while the caret sits in a live "@query" token — the mention menu
  // (files/directories from the server finder, plus mentionable agents).
  // `atIndex` is the highlighted match.
  const [atQuery, setAtQuery] = useState<string | undefined>();
  const [atIndex, setAtIndex] = useState(0);
  const [atFiles, setAtFiles] = useState<string[]>([]);
  const atSeq = useRef(0);
  const [dragOver, setDragOver] = useState(false);

  const resize = (el: HTMLTextAreaElement) => {
    el.style.height = "auto";
    el.style.height = `${el.scrollHeight}px`;
  };

  // Prompt history sweep (Claude Code): Up with the caret stuck on the first
  // line recalls this session's previous prompt, Down past the newest hands
  // the draft back. The draft (and its caret) is saved on the first step out.
  const [histIndex, setHistIndex] = useState<number | undefined>();
  const savedDraft = useRef<{ text: string; caret: number } | undefined>(
    undefined,
  );
  useEffect(() => {
    setHistIndex(undefined);
    savedDraft.current = undefined;
  }, [props.sessionId]);
  const resetSweep = () => {
    setHistIndex(undefined);
    savedDraft.current = undefined;
  };
  // Sent prompts of this session, oldest first — the walk counts from the end.
  const sentPrompts = () =>
    (props.sessionId
      ? messagesBySession.value.get(props.sessionId)
      : []
    )
      ?.filter((m) => m.info.role === "user")
      .map((m) =>
        m.parts
          .filter(isText)
          .filter((p) => !p.synthetic)
          .map((p) => p.text ?? "")
          .join("\n")
          .trim(),
      )
      .filter(Boolean) ?? [];

  // Host "add to chat": append the text and focus. A revert's insert swaps
  // the draft whole — the message comes back for editing. The insert is a
  // mailbox, consumed on arrival: effects re-run on every mount, so a
  // leftover payload would re-fill the input of the NEXT session you open —
  // and re-fill it again after every clear, forever.
  useEffect(() => {
    const ins = composerInsert.value;
    const el = ref.current;
    if (!ins || !el) return;
    composerInsert.value = undefined;
    el.value = ins.replace
      ? ins.text
      : (el.value ? `${el.value.replace(/\s+$/, "")}\n\n` : "") + ins.text;
    resize(el);
    syncText(el);
    putDraft(draftKey, el.value);
    resetSweep();
    el.focus();
  }, [composerInsert.value]);

  // Restore the saved draft. Runs after the insert effect above, so an
  // insert consumed on this mount (a host handoff while the view was closed)
  // is already in the map and the restore re-applies the same value.
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    el.value = getDraft(draftKey);
    resize(el);
    syncText(el);
  }, [draftKey]);

  const matches =
    slashQuery !== undefined
      ? [...BUILTIN_COMMANDS, ...commands.value].filter((c) =>
          c.name.startsWith(slashQuery),
        )
      : [];

  // Finder results for the live query, debounced; the seq drops responses
  // overtaken by a newer query. Scoped to the session's directory (a draft
  // searches this window's folder).
  useEffect(() => {
    if (atQuery === undefined) return;
    // A new query must not show the old one's rows while the fetch is out.
    setAtFiles([]);
    const seq = ++atSeq.current;
    const t = window.setTimeout(() => {
      const dir =
        (props.sessionId
          ? sessions.value.find((s) => s.id === props.sessionId)?.location
              ?.directory
          : currentDir.value) || undefined;
      void findFiles(atQuery, dir).then((rows) => {
        if (seq === atSeq.current) setAtFiles(rows);
      });
    }, 150);
    return () => clearTimeout(t);
  }, [atQuery, props.sessionId]);

  // The mention menu: agents first (few), then finder paths (directories
  // carry their trailing "/" from the server).
  type AtMatch =
    | { kind: "agent"; name: string }
    | { kind: "file" | "dir"; path: string };
  const atMatches: AtMatch[] =
    atQuery === undefined
      ? []
      : [
          ...agents.value
            .filter(
              (a) =>
                !a.hidden &&
                a.mode !== "primary" &&
                a.name.startsWith(atQuery),
            )
            .map((a) => ({ kind: "agent" as const, name: a.name })),
          ...atFiles.map((p) => ({
            kind: (p.endsWith("/") ? "dir" : "file") as "dir" | "file",
            path: p,
          })),
        ];

  // Arrow-walking the menus scrolls the highlighted row into view — the
  // list clips at max-height and nothing else moves it as the walk wraps.
  // offsetTop is menu-relative (.slash-menu is the items' offsetParent);
  // manual scrollTop math instead of scrollIntoView keeps the transcript's
  // scroll containers out of it.
  const slashMenuRef = useRef<HTMLDivElement>(null);
  const atMenuRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const follow = (menu: HTMLDivElement | null) => {
      const active = menu?.querySelector<HTMLElement>(".menu-item.active");
      if (!menu || !active) return;
      const top = active.offsetTop;
      const bottom = top + active.offsetHeight;
      if (top < menu.scrollTop) menu.scrollTop = top;
      else if (bottom > menu.scrollTop + menu.clientHeight)
        menu.scrollTop = bottom - menu.clientHeight;
    };
    follow(slashMenuRef.current);
    follow(atMenuRef.current);
  }, [slashIndex, atIndex, matches.length, atMatches.length]);

  // Complete the live "@query" with a match: files/agents insert "@x "
  // (closing the menu), a directory inserts "@dir/" and keeps the menu open
  // on the deeper query (drill-down, the TUI's expand).
  const pickAt = (item: AtMatch) => {
    const el = ref.current;
    if (!el) return;
    const caret = el.selectionStart ?? el.value.length;
    const m = /(?:^|\s)@([^\s@]*)$/.exec(el.value.slice(0, caret));
    if (!m) {
      setAtQuery(undefined);
      return;
    }
    const at = caret - m[1].length - 1;
    const ins =
      item.kind === "agent"
        ? `@${item.name} `
        : `@${item.path}${item.kind === "dir" ? "" : " "}`;
    el.value = el.value.slice(0, at) + ins + el.value.slice(caret);
    el.focus();
    const c = at + ins.length;
    el.setSelectionRange(c, c);
    resize(el);
    syncText(el);
    putDraft(draftKey, el.value);
    setAtIndex(0);
    setAtQuery(item.kind === "dir" ? item.path : undefined);
  };

  // Complete the live "/query" with a match (Tab); Enter is the one that
  // runs — matching the @-menu, where both keys only complete. The slash
  // menu opens on a bare "/query" alone, so the value is replaced whole,
  // and the trailing space closes the menu for arguments.
  const pickSlash = (item: { name: string }) => {
    const el = ref.current;
    if (!el) return;
    el.value = `/${item.name} `;
    el.focus();
    const c = el.value.length;
    el.setSelectionRange(c, c);
    resize(el);
    syncText(el);
    putDraft(draftKey, el.value);
    setSlashQuery(undefined);
  };

  const send = () => {
    const el = ref.current;
    const text = el?.value ?? "";
    // Busy stays sendable — prompts are steered into the running turn by
    // the server (delivered as the next one); commands have no server
    // queue, so they're held client-side and fire when the turn ends.
    if (!el || !text.trim()) return;
    el.value = "";
    resize(el);
    syncText(el);
    dropDraft(draftKey);
    resetSweep();
    setSlashQuery(undefined);
    // Enter may beat the finder debounce: kill the pending @-query so the
    // late fetch can't pop the mention menu over the just-cleared textarea.
    setAtQuery(undefined);
    setAtIndex(0);
    if (text.startsWith("/") && busy) {
      queueCommand(props.sessionId ?? "draft", text);
    } else if (text.startsWith("/")) {
      void runSlashCommand(props.sessionId ?? "draft", text);
    } else {
      void sendPrompt(props.sessionId ?? "draft", text, files);
    }
  };

  const removeFile = (i: number) => {
    composerFiles.value = {
      ...composerFiles.value,
      [draftKey]: files.filter((_, j) => j !== i),
    };
  };

  // Paste of file/image content attaches; plain text keeps default pasting.
  const onPaste = (e: JSX.TargetedClipboardEvent<HTMLTextAreaElement>) => {
    const files = Array.from(e.clipboardData?.files ?? []);
    if (files.length === 0) return;
    e.preventDefault();
    void attachFiles(props.sessionId, files);
  };

  // File drops are captured at window level: anything dropped over the chat
  // attaches (no need to aim at the composer). VS Code-internal drags from
  // its explorer carry no Files — "resourceurls"/"codeeditors" (Claude
  // Code's seam) and "text/uri-list" hold the real file URIs.
  useEffect(() => {
    const types = (e: DragEvent) => Array.from(e.dataTransfer?.types ?? []);
    const interesting = (e: DragEvent) =>
      types(e).some((t) => {
        const k = t.toLowerCase();
        return k === "files" || k === "resourceurls" || k === "codeeditors";
      });
    let endTimer: number | undefined;
    let watchTimer: number | undefined;
    const end = () => setDragOver(false);
    const onOver = (e: DragEvent) => {
      if (!interesting(e)) return;
      e.preventDefault(); // lets the window receive `drop`
      clearTimeout(endTimer);
      clearTimeout(watchTimer);
      setDragOver(true);
      // drags stolen by the workbench stop delivering dragover entirely.
      watchTimer = window.setTimeout(end, 1200);
    };
    const onLeave = () => {
      clearTimeout(endTimer);
      endTimer = window.setTimeout(end, 150);
    };
    const onDrop = (e: DragEvent) => {
      if (!interesting(e)) return;
      e.preventDefault();
      e.stopPropagation();
      clearTimeout(endTimer);
      clearTimeout(watchTimer);
      end();
      const dt = e.dataTransfer;
      const files = Array.from(dt?.files ?? []);
      if (files.length > 0) {
        void attachFiles(props.sessionId, files);
        return;
      }
      let urls: string[] = [];
      try {
        urls = JSON.parse(dt?.getData("resourceurls") ?? "[]");
      } catch {
        urls = [];
      }
      if (urls.length === 0) {
        urls = (dt?.getData("text/uri-list") ?? "")
          .split(/\r?\n/)
          .filter((l: string) => l && !l.startsWith("#"));
      }
      const refs = urls.map((u) => ({
        uri: u,
        name: decodeURIComponent(u.split("/").pop() ?? "file"),
      }));
      if (refs.length > 0) addComposerFiles(draftKey, refs);
    };
    window.addEventListener("dragover", onOver);
    window.addEventListener("dragleave", onLeave);
    window.addEventListener("drop", onDrop);
    return () => {
      window.removeEventListener("dragover", onOver);
      window.removeEventListener("dragleave", onLeave);
      window.removeEventListener("drop", onDrop);
      clearTimeout(endTimer);
      clearTimeout(watchTimer);
    };
  }, [draftKey]);

  // Fire the highlighted (or clicked) command, keeping any typed arguments.
  const runCommand = (name: string) => {
    const el = ref.current;
    if (!el) return;
    // A command fired onto a running turn is queued client-side — it
    // starts its own turn, so it waits for an idle one.
    const rest = el.value.replace(/^\/\S*\s*/, "").trim();
    const line = `/${name}${rest ? ` ${rest}` : ""}`;
    if (busy) {
      queueCommand(props.sessionId ?? "draft", line);
    } else {
      void runSlashCommand(props.sessionId ?? "draft", line);
    }
    el.value = "";
    resize(el);
    syncText(el);
    dropDraft(draftKey);
    setSlashQuery(undefined);
  };

  const onKeyDown = (e: JSX.TargetedKeyboardEvent<HTMLTextAreaElement>) => {
    const el = e.currentTarget;
    if (matches.length > 0) {
      if (e.key === "ArrowDown" || e.key === "ArrowUp") {
        e.preventDefault();
        // Walk only the rendered rows (render clips at 8) so the highlight
        // never lands on an entry the menu doesn't show.
        const n = Math.min(matches.length, 8);
        const dir = e.key === "ArrowDown" ? 1 : n - 1;
        setSlashIndex((i) => (i + dir) % n);
        return;
      }
      if (e.key === "Enter" && !e.isComposing) {
        e.preventDefault();
        runCommand(matches[Math.min(slashIndex, matches.length - 1)].name);
        return;
      }
      if (e.key === "Tab" && !e.isComposing) {
        e.preventDefault();
        pickSlash(matches[Math.min(slashIndex, matches.length - 1)]);
        return;
      }
      if (e.key === "Escape") {
        e.preventDefault();
        setSlashQuery(undefined);
        return;
      }
    }
    if (atMatches.length > 0) {
      if (e.key === "ArrowDown" || e.key === "ArrowUp") {
        e.preventDefault();
        // Walk only the rendered rows (render clips at 10).
        const n = Math.min(atMatches.length, 10);
        const step = e.key === "ArrowDown" ? 1 : n - 1;
        setAtIndex((i) => (i + step) % n);
        return;
      }
      if ((e.key === "Enter" || e.key === "Tab") && !e.isComposing) {
        e.preventDefault();
        pickAt(atMatches[Math.min(atIndex, atMatches.length - 1)]);
        return;
      }
      if (e.key === "Escape") {
        e.preventDefault();
        setAtQuery(undefined);
        setAtIndex(0);
        return;
      }
    }
    if (e.key === "Escape") {
      e.preventDefault();
      // The image preview floats over everything; dismiss it first — even
      // focused on the editor, Esc must not stop a turn underneath it.
      // (The Lightbox's window keydown does the closing; this editor
      // handler fires before it and must just stand down.)
      if (imgPreview.value) return;
      // Esc stops a running turn (Claude Code parity) — the zhipuai
      // endpoint's empty-step loops keep a dead turn busy with no way out
      // but the stop button. Idle, it drops focus back to the editor.
      if (busy && props.sessionId) {
        void stopSession(props.sessionId);
        return;
      }
      el.blur();
      postToHost({ type: "escape-pressed" });
      return;
    }
    // History sweep, only when the arrow can't move the caret anyway: Up on
    // the first line, Down on the last (a selection or a modifier means
    // ordinary caret work). Recalled prompts get the caret at their top so
    // the walk continues with the same key.
    if (
      (e.key === "ArrowUp" || e.key === "ArrowDown") &&
      !e.shiftKey &&
      !e.altKey &&
      !e.ctrlKey &&
      !e.metaKey &&
      !e.isComposing
    ) {
      const list = sentPrompts();
      const atTop =
        el.selectionStart === el.selectionEnd &&
        !el.value.slice(0, el.selectionStart).includes("\n");
      const atBottom =
        el.selectionStart === el.selectionEnd &&
        !el.value.slice(el.selectionEnd).includes("\n");
      const back = (i: number) => {
        if (histIndex === undefined)
          savedDraft.current = { text: el.value, caret: el.selectionStart };
        setHistIndex(i);
        el.value = list[i];
        resize(el);
        syncText(el);
        putDraft(draftKey, list[i]);
        el.setSelectionRange(0, 0);
      };
      if (e.key === "ArrowUp" && atTop && (histIndex ?? list.length) > 0) {
        e.preventDefault();
        back((histIndex ?? list.length) - 1);
        return;
      }
      if (e.key === "ArrowDown" && atBottom && histIndex !== undefined) {
        e.preventDefault();
        if (histIndex + 1 < list.length) {
          back(histIndex + 1);
          return;
        }
        const d = savedDraft.current;
        resetSweep();
        el.value = d?.text ?? "";
        resize(el);
        syncText(el);
        putDraft(draftKey, el.value);
        el.setSelectionRange(d?.caret ?? 0, d?.caret ?? 0);
        return;
      }
    }
    if (e.key === "Enter" && !e.shiftKey && !e.isComposing) {
      e.preventDefault();
      send();
    }
  };

  return (
    <div class="composer">
      {dragOver && <div class="drop-overlay">Drop files to attach</div>}
      <div class="composer-card">
        {matches.length > 0 && (
          <div class="menu slash-menu" ref={slashMenuRef}>
            {matches.slice(0, 8).map((c, i) => (
              <button
                key={c.name}
                class={i === slashIndex ? "menu-item active" : "menu-item"}
                onMouseDown={() => runCommand(c.name)}
              >
                <span class="menu-texts">
                  <span class="menu-label">/{c.name}</span>
                  {c.description && (
                    <span class="menu-sub">{c.description}</span>
                  )}
                </span>
              </button>
            ))}
          </div>
        )}
        {atMatches.length > 0 && (
          <div class="menu slash-menu" ref={atMenuRef}>
            {atMatches.slice(0, 10).map((item, i) => (
              <button
                key={item.kind === "agent" ? `a:${item.name}` : `f:${item.path}`}
                class={
                  i === Math.min(atIndex, atMatches.length - 1)
                    ? "menu-item active"
                    : "menu-item"
                }
                /* Mousedown must not pull focus off the textarea — the menu
                   rides the caret, and blur closes it. */
                onMouseDown={(e) => e.preventDefault()}
                onClick={() => pickAt(item)}
              >
                <span class="menu-texts">
                  <span class="menu-label">
                    @{item.kind === "agent" ? item.name : item.path}
                  </span>
                  {item.kind === "agent" && (
                    <span class="menu-sub">agent</span>
                  )}
                  {item.kind === "dir" && (
                    <span class="menu-sub">directory</span>
                  )}
                </span>
              </button>
            ))}
          </div>
        )}
        {files.length > 0 && (
          <div class="composer-files">
            {files.map((f, i) =>
              f.uri.startsWith("data:image/") ? (
                <span
                  class="file-chip chip-img"
                  key={`${f.name}:${i}`}
                  title={f.name}
                  onClick={() => openLightbox({ uri: f.uri, name: f.name })}
                >
                  <img src={f.uri} alt={f.name} />
                  <button
                    type="button"
                    class="chip-x"
                    title="Remove"
                    aria-label={`Remove ${f.name}`}
                    onClick={(e) => {
                      // Removing must not open the chip's preview.
                      e.stopPropagation();
                      removeFile(i);
                    }}
                  >
                    ×
                  </button>
                </span>
              ) : (
                <span
                  class={
                    f.uri.startsWith("file:") ? "file-chip chip-open" : "file-chip"
                  }
                  key={`${f.name}:${i}`}
                  title={f.uri.startsWith("file:") ? `${f.name} (click to open)` : f.name}
                  onClick={() => {
                    // The + picker's picks keep their on-disk path — open
                    // it, text in the editor, else the system tool.
                    if (!f.uri.startsWith("file:")) return;
                    (attachMime(f.name, "") === "text/plain"
                      ? openFile
                      : openExternal)(f.uri);
                  }}
                >
                  <span class="chip-ext">{extOf(f.name).toUpperCase()}</span>
                  <span class="chip-name">{f.name}</span>
                  <button
                    type="button"
                    class="chip-x"
                    title="Remove"
                    aria-label={`Remove ${f.name}`}
                    onClick={(e) => {
                      // Removing must not also open the chip's file.
                      e.stopPropagation();
                      removeFile(i);
                    }}
                  >
                    ×
                  </button>
                </span>
              ),
            )}
          </div>
        )}
        <textarea
          ref={ref}
          rows={1}
          autoFocus={!props.sessionId}
          placeholder="Ask anything, / for commands, @ for context..."
          onInput={(e) => {
            resize(e.currentTarget);
            syncText(e.currentTarget);
            putDraft(draftKey, e.currentTarget.value);
            const m = /^\/\S*$/.exec(e.currentTarget.value);
            setSlashQuery(m ? m[0].slice(1) : undefined);
            setSlashIndex(0);
            setAtQuery(
              atTrigger(
                e.currentTarget.value,
                e.currentTarget.selectionStart ?? e.currentTarget.value.length,
              ),
            );
            setAtIndex(0);
          }}
          onKeyDown={onKeyDown}
          onPaste={onPaste}
          // Leaving the editor closes the mention menu (the slash menu is
          // input-driven only; the mention menu would otherwise survive a
          // click-away with a stale caret).
          onBlur={() => setAtQuery(undefined)}
        />
        <div class="composer-bar">
          <button
            type="button"
            class="comp-add"
            title="Attach file"
            aria-label="Attach file"
            onClick={() => postToHost({ type: "attach-file" })}
          >
            <PlusIcon />
          </button>
          <ModelPicker id={props.sessionId} />
          <VariantPicker id={props.sessionId} />
          <AgentPicker id={props.sessionId} />
          <span class="spacer" />
          {busy && props.sessionId && !hasText ? (
            <button
              type="button"
              class="comp-send"
              title="Stop"
              aria-label="Stop"
              onClick={() => void stopSession(props.sessionId!)}
            >
              <StopIcon />
            </button>
          ) : (
            <button
              type="button"
              class="comp-send"
              title="Send"
              aria-label="Send"
              onClick={send}
            >
              <ArrowUpIcon />
            </button>
          )}
        </div>
      </div>
    </div>
  );
}
