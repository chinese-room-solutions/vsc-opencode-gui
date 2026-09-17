import { useEffect, useState } from "preact/hooks";
import hljs from "highlight.js/lib/common";
import type { ToolPart } from "../api";
import { isTool, toolName } from "../api";
import { openFile, openUrl } from "../host";
import { route, navigate } from "../router";
import {
  pendingPermissions,
  pendingQuestions,
  sessionWorking,
  sessions,
  stopSession,
} from "../store";
import { silenceLabel } from "../stuck";
import { CheckIcon, CopyIcon, PixelMark, PixelSpinner, StopIcon } from "../icons";

// One-line tool rows: status dot + display name + the
// command/argument as a gray code pill, clipped to a single line. Under it,
// Claude Code's tool body — IN (the command, shell-like calls) and OUT (the
// result) — folded by default like the thinking block, so the transcript
// stays one line per tool until the reader asks for the details.

function inputStr(part: ToolPart, ...keys: string[]): string | undefined {
  const input = part.state?.input;
  for (const k of keys) {
    const v = input?.[k];
    if (typeof v === "string" && v) return v;
  }
  return undefined;
}

// The todo rows a todowrite call recorded — live in the call input until the
// result lands, then mirrored into structured.
function todoRows(part: ToolPart): { content?: string; status?: string }[] {
  const fromInput = part.state?.input?.todos;
  if (Array.isArray(fromInput)) return fromInput as never[];
  const fromResult = (
    part.state?.structured as { todos?: unknown } | undefined
  )?.todos;
  if (Array.isArray(fromResult)) return fromResult as never[];
  return [];
}

// File names an apply_patch call touched (structured.files[]; a patch can
// span several).
function patchFilePaths(part: ToolPart): string[] {
  const files = (
    part.state?.structured as { files?: { file?: unknown }[] } | undefined
  )?.files;
  if (!Array.isArray(files)) return [];
  return files
    .map((f) => (typeof f?.file === "string" ? f.file : ""))
    .filter(Boolean);
}

// The unified patch strings both dialects deliver for edit and apply_patch
// (one per file, already diff-formatted). Older rows carried metadata.diff.
function diffText(part: ToolPart): string {
  const meta = part.state?.metadata?.diff;
  const files = part.state?.structured?.files;
  if (Array.isArray(files)) {
    const patches = files
      .map((f) => (typeof (f as { patch?: unknown })?.patch === "string"
        ? (f as { patch: string }).patch
        : ""))
      .filter(Boolean);
    if (patches.length > 0) return patches.join("\n");
  }
  return typeof meta === "string" ? meta : "";
}

// The child session this chip opens. Live parts carry it in state.metadata
// (the tool records the id when it spawns the session); durable rows lose
// that field in the fetch decode, so there it resolves from the session
// store instead — the newest child of this session whose title is the task
// description, which is the title the server gives every spawned sub-agent
// ("<description> (@<agent> subagent)").
function childSessionId(part: ToolPart, description: string): string | undefined {
  const live =
    typeof part.state?.metadata?.sessionId === "string"
      ? (part.state.metadata.sessionId as string)
      : undefined;
  if (live) return live;
  const parent = route.value.view === "session" ? route.value.id : undefined;
  if (!parent) return undefined;
  const kids = sessions.value
    .filter(
      (s) => s.parentID === parent && description && s.title.startsWith(description),
    )
    // Newest wins: descriptions repeat across children (two sub-agents can
    // carry the same label), and the chip must open the one this part
    // spawned — the most recent — not whichever the fetch order put last.
    .sort((a, b) => b.time.updated - a.time.updated);
  return kids[0]?.id;
}

// "general" → "General"; "oc-model-glm-5-3-flash" → "Oc-Model-Glm-5-3-Flash",
// matching how the official app spells agent names on the chip.
function displayAgent(raw: string | undefined): string {
  if (!raw) return "Subagent";
  return raw
    .split(/[-_]/)
    .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
    .join("-");
}

// The v2 engine has no task tool, so the `task` skill teaches the model to
// delegate through a marked bash command running the extension's stub; the
// stub prints the child session id before the sub-agent's result, which is
// what the chip opens.
const SUBAGENT_STUB = "oc-subagent.js";
const CHILD_ID = /\[sub-agent session: (ses_[^\]\s]+)\]/;
// The --flag matchers, compiled once — parseSubagentCommand runs per parent
// re-render (every streaming delta).
const SUBAGENT_DESC_RE = /--description (?:"([^"]*)"|([^\s"]+))/;
const SUBAGENT_AGENT_RE = /--agent (?:"([^"]*)"|([^\s"]+))/;
const flagValue = (command: string, re: RegExp): string | undefined => {
  const m = command.match(re);
  return m?.[1] ?? m?.[2];
};

function parseSubagentCommand(
  command: string,
): { agent: string; rawAgent: string; description: string } | undefined {
  const description = flagValue(command, SUBAGENT_DESC_RE);
  if (!command.includes(SUBAGENT_STUB) || !description) return undefined;
  const rawAgent = flagValue(command, SUBAGENT_AGENT_RE) ?? "general";
  return { agent: displayAgent(rawAgent), rawAgent, description };
}

// The stub child has no parentID (POST /session ignores it), so it resolves
// by the title the stub writes — newest match wins.
function stubChildId(marked: { rawAgent: string; description: string }): string | undefined {
  const kids = sessions.value
    .filter(
      (s) =>
        marked.description &&
        s.title.startsWith(marked.description) &&
        s.title.includes(`@${marked.rawAgent} subagent`),
    )
    .sort((a, b) => b.time.updated - a.time.updated);
  return kids[0]?.id;
}

// One chip standing in for a whole sub-agent session, like the official
// app's — status dot, agent name, the task's description; a blinking dot
// while it runs. The chip falls through to the child session on click and is
// inert until one is resolvable. Background tasks read "… (background)"
// server-side; the same word on the chip keeps the two apart. A pending
// permission ask or question in the child pulses the chip yellow — the ask
// itself docks only in the child's view, so this is the cue in the parent.
// The card's stop button stops the child deliberately, and the stuck
// watcher auto-stops a dead one.
function SubagentChip(props: {
  agent: string;
  description: string;
  sessionId?: string;
  running?: boolean;
  failed?: boolean;
  background?: boolean;
  asking?: "permission" | "question";
}) {
  const { sessionId, running, background } = props;
  // Sub-session drill-down, like the official app: the tab keeps belonging
  // to the root session and the child rides the route as a breadcrumb. A
  // chip inside a child re-roots there (two levels shown).
  const open = () => {
    if (!sessionId) return;
    const r = route.value;
    if (r.view === "session") {
      navigate({ view: "session", id: r.child ?? r.id, child: sessionId });
    } else {
      navigate({ view: "session", id: sessionId });
    }
  };
  return (
    <div
      class={[
        "subagent-chip",
        sessionId && "link",
        // The pulse follows the sub-agent actually working — including a
        // relayed turn re-activating a settled card — not the card being
        // part of the live turn.
        running && "live",
        props.asking && "asking",
      ]
        .filter(Boolean)
        .join(" ")}
      role={sessionId ? "button" : undefined}
      tabIndex={sessionId ? 0 : undefined}
      title={
        props.asking === "permission"
          ? "Sub-agent is waiting for a permission decision"
          : props.asking === "question"
            ? "Sub-agent is waiting for your answer"
            : sessionId
              ? background
                ? "Open background sub-agent session"
                : "Open sub-agent session"
              : "Sub-agent session not available"
      }
      onClick={open}
      onKeyDown={(e) => {
        if (!sessionId) return;
        if (e.key === "Enter" || e.key === " ") {
          e.preventDefault();
          open();
        }
      }}
    >
      {running ? (
        // opencode's pixel spinner while the sub-agent works; the settled
        // chip keeps the same square, at rest.
        <PixelSpinner />
      ) : (
        <PixelMark failed={props.failed} />
      )}
      <span class="subagent-agent">{props.agent}</span>
      <span class="subagent-desc">
        {background ? `${props.description} (background)` : props.description}
      </span>
      {/* Stop kills only the child session's loop — the parent's turn gets
          the aborted task result and continues on its own. Rendered while it
          asks too: a child the user wants dead must not wait on its own
          permission ask. */}
      {(running || props.asking) && sessionId && (
        <button
          type="button"
          class="subagent-stop"
          title="Stop the sub-agent"
          aria-label="Stop the sub-agent"
          onClick={(e) => {
            e.stopPropagation();
            void stopSession(sessionId);
          }}
        >
          <StopIcon />
        </button>
      )}
    </div>
  );
}

// One labeled row of the tool body, with its own copy button on the right
// of the first line.
function BodyRow(props: { label: "IN" | "OUT"; text: string }) {
  const [copied, setCopied] = useState(false);
  const copy = () => {
    void navigator.clipboard.writeText(props.text).catch(() => {});
    setCopied(true);
    window.setTimeout(() => setCopied(false), 1200);
  };
  return (
    <div class="tool-body-row">
      <span class="tool-body-label">{props.label}</span>
      <div class="tool-body-text">{props.text}</div>
      <button
        type="button"
        class={copied ? "tool-copy done" : "tool-copy"}
        title="Copy"
        aria-label={`Copy ${props.label}`}
        onClick={(e) => {
          e.stopPropagation();
          copy();
        }}
      >
        {copied ? <CheckIcon /> : <CopyIcon />}
      </button>
    </div>
  );
}

// The pill text: the command for bash, the file path for edit/write, the
// todo progress, the tool's own title or first descriptive argument otherwise.
function summary(part: ToolPart): string {
  if (part.tool === "bash") {
    return inputStr(part, "command") ?? part.state?.title ?? "";
  }
  if (part.tool === "edit" || part.tool === "write") {
    return inputStr(part, "filePath", "file", "path") ?? part.state?.title ?? "";
  }
  if (part.tool === "apply_patch") {
    // Official app: the one file, or "N files" (their i18n wording aside).
    const files = patchFilePaths(part);
    if (files.length > 1) return `${files.length} files`;
    if (files.length === 1) return files[0];
    return (
      inputStr(part, "patchText")?.match(
        /^\*\*\* (?:Add|Update|Delete) File: (.+)$/m,
      )?.[1] ??
      part.state?.title ??
      ""
    );
  }
  if (part.tool === "todowrite") {
    const todos = todoRows(part);
    if (todos.length > 0) {
      return `${todos.filter((t) => t.status === "completed").length}/${todos.length}`;
    }
  }
  if (part.tool === "question") {
    const qs = part.state?.input?.questions as
      | { question?: string }[]
      | undefined;
    return qs?.[0]?.question ?? part.state?.title ?? "";
  }
  return (
    part.state?.title ??
    inputStr(
      part,
      "url",
      "filePath",
      "file",
      "pattern",
      "path",
      "name",
      "query",
    ) ??
    ""
  );
}

function highlightDiff(diff: string): string {
  try {
    return hljs.highlight(diff, { language: "diff" }).value;
  } catch {
    return diff.replace(/&/g, "&amp;").replace(/</g, "&lt;");
  }
}

// Added/removed line counts for the row's +/- stat (the original app's
// "Edit README.md +2 -0"), read straight off the unified patch — the
// +++/--- header lines don't count.
function diffStats(diff: string): { add: number; del: number } {
  let add = 0;
  let del = 0;
  for (const line of diff.split("\n")) {
    if (line.startsWith("+++") || line.startsWith("---")) continue;
    if (line.startsWith("+")) add++;
    else if (line.startsWith("-")) del++;
  }
  return { add, del };
}

export function ToolCard(props: { part: ToolPart; live?: boolean }) {
  const part = props.part;
  const { state } = part;
  // The todo list IS the todowrite result — like the official app, that one
  // card starts open.
  const [open, setOpen] = useState(part.tool === "todowrite");
  // Elapsed-on-hover, the row's timer in place of the old "Show" title:
  // ticking while the part runs in the live turn, the total once it
  // settles. The tick only drives re-renders — the tip itself is plain
  // text swapping in place, no animation (the dot's blink must not
  // reach it, which is why it rides the row, not the dot).
  const running = props.live === true && state?.status === "running";
  const [, tick] = useState(0);
  useEffect(() => {
    if (!running) return;
    const t = window.setInterval(() => tick((n) => n + 1), 1000);
    return () => window.clearInterval(t);
  }, [running]);
  const start = state?.time?.start;
  const end = state?.time?.end;
  const elapsed =
    running && start
      ? silenceLabel(Date.now() - start)
      : !running && start && end
        ? silenceLabel(end - start)
        : undefined;
  // A sub-agent relayed new facts (steer) or re-attached after an interrupt
  // runs again long after its bash call closed — the child session's own
  // status keeps the chip honest then. Retry counts as working (see
  // sessionWorking): the provider backoff is mid-turn, not finished.
  const childBusy = (id: string | undefined) => sessionWorking(id);
  // The child's pending asks — the chip's asking pulse. Permissions and
  // questions both stall the child on the user; the title says which.
  const childAsk = (
    id: string | undefined,
  ): "permission" | "question" | undefined => {
    if (id === undefined) return undefined;
    if (pendingPermissions.value.some((p) => p.sessionID === id))
      return "permission";
    if (pendingQuestions.value.some((q) => q.sessionID === id))
      return "question";
    return undefined;
  };

  // A spawned sub-agent is the one tool that renders as a link, not a card:
  // its details live in the child session, one click away. Native task tool
  // calls, and (until the v2 engine grows a task tool) the marked stub
  // command the task skill teaches, both render as the same chip. A part
  // stuck "running"/"pending" vouches for liveness only inside the live
  // turn: a server death leaves it unfinalized in the store, and trusting
  // it after a reload spins chips for work nothing is doing. The child's
  // own status decides then (a steer re-activating a settled card included).
  if (part.tool === "task") {
    const status = part.state?.status ?? "pending";
    const description =
      inputStr(part, "description") ?? part.state?.title ?? "task";
    const sessionId = childSessionId(part, description);
    const running =
      (props.live === true &&
        (status === "pending" || status === "running")) ||
      childBusy(sessionId);
    return (
      <>
        <SubagentChip
          agent={displayAgent(inputStr(part, "subagent_type", "subagentType", "agent"))}
          description={description}
          sessionId={sessionId}
          running={running}
          failed={status === "error" || !!part.state?.error}
          background={part.state?.metadata?.background === true}
          asking={childAsk(sessionId)}
        />
      </>
    );
  }
  if (part.tool === "bash") {
    const marked = parseSubagentCommand(inputStr(part, "command") ?? "");
    if (marked) {
      const status = part.state?.status ?? "pending";
      const sessionId =
        part.state?.output?.match(CHILD_ID)?.[1] ?? stubChildId(marked);
      const running =
        (props.live === true &&
          (status === "pending" || status === "running")) ||
        childBusy(sessionId);
      return (
        <>
          <SubagentChip
            agent={marked.agent}
            description={marked.description}
            sessionId={sessionId}
            running={running}
            failed={status === "error" || !!part.state?.error}
            asking={childAsk(sessionId)}
          />
        </>
      );
    }
  }

  const status = state?.status ?? "pending";
  const output = state?.error || state?.output || "";
  // A kill (abort) finalizes the tool "completed" — the failure rides in
  // state.error when there is one, and for shells only in the output's
  // <shell_metadata> ("User aborted the command"). The dot and the row
  // must read failed, not done.
  const failed =
    status === "error" ||
    (!!state?.error && state.error !== "") ||
    output.includes("User aborted the command");
  const path =
    part.tool === "edit" || part.tool === "write"
      ? inputStr(part, "filePath", "file", "path")
      : undefined;
  // apply_patch names its file only in the structured result.
  const patchPath = part.tool === "apply_patch" ? patchFilePaths(part)[0] : undefined;
  const linkPath = path ?? patchPath;
  // Fetch rows link their URL (opens in the browser, host-side).
  const url = part.tool === "webfetch" ? inputStr(part, "url") : undefined;
  const diff = diffText(part);
  // The +/- stat rides the collapsed row (the original app's), so it only
  // computes for the file-changing tools whose diff the body would show.
  const stat =
    diff && (part.tool === "edit" || part.tool === "write" || part.tool === "apply_patch")
      ? diffStats(diff)
      : undefined;
  // The checklist replaces the raw OUT (the todos JSON); only a failure
  // still shows the text.
  const todos = part.tool === "todowrite" ? todoRows(part) : [];
  const outText = part.tool === "todowrite" && !failed ? "" : output;
  // IN carries the command for shell-like calls; other tools name their
  // target in the header pill, so only OUT applies to them.
  const command =
    part.tool === "bash" ? (inputStr(part, "command") ?? "") : "";
  const expandable = Boolean(command || outText || diff || todos.length);

  return (
    <div
      class={`tool${failed ? " tool-error" : ""}${props.live ? " live" : ""}`}
    >
      <div
        class={expandable ? "tool-row expander" : "tool-row"}
        data-tip={elapsed}
        onClick={expandable ? () => setOpen(!open) : undefined}
      >
        {/* "failed", not "error": the app's boot-error banner owns .error. */}
        <span class={`tool-dot ${failed ? "failed" : status}`} aria-hidden="true" />
        <span class="tool-name">{toolName(part.tool)}</span>
        {linkPath || url ? (
          <a
            class="tool-pill file-ref"
            onClick={(e) => {
              e.preventDefault();
              e.stopPropagation();
              if (url) openUrl(url);
              else if (linkPath) openFile(linkPath);
            }}
          >
            {summary(part)}
          </a>
        ) : (
          <span class="tool-pill">{summary(part)}</span>
        )}
        {stat && (
          <span class="diff-stat" aria-hidden="true">
            <span class="diff-add">+{stat.add}</span>
            <span class="diff-del">-{stat.del}</span>
          </span>
        )}
      </div>
      {open && (
        <>
          {todos.length > 0 && (
            <div class="tool-todos">
              {todos.map((t, i) => (
                <div
                  key={i}
                  class={`tool-todo${t.status === "completed" ? " done" : ""}`}
                >
                  <span class="tool-todo-box" aria-hidden="true">
                    {t.status === "completed" && <CheckIcon />}
                  </span>
                  <span class="tool-todo-text">{t.content}</span>
                </div>
              ))}
            </div>
          )}
          {(command || outText) && (
            <div class="tool-body">
              {command && <BodyRow label="IN" text={command} />}
              {outText && <BodyRow label="OUT" text={outText} />}
            </div>
          )}
          {diff && (
            <pre
              class="diff hljs"
              dangerouslySetInnerHTML={{ __html: highlightDiff(diff) }}
            />
          )}
        </>
      )}
      </div>
  );
}

