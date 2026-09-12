// Sub-agent runner for the `oc-task` skill. The opencode v2 engine has no task
// tool (and no plugin/MCP tools), so the skill teaches the model to run this
// script via bash; the script drives the server's own HTTP API. Every command
// is non-blocking: spawn starts a real child session and returns immediately
// with its id (--wait later collects the answer), --text relays new facts
// into a running or finished sub-agent, --wait polls for up to a cap and
// prints either the sub-agent's answer or a one-line work status, and --abort
// kills a wedged child. The CALLING agent loops the polls and judges from the
// status whether the child is stuck — no fixed timer decides that for it.
// Runs inside the server's bash environment, so it inherits OPENCODE_GUI_PORT
// from the spawn env.
//
// Zero dependencies on purpose: it is copied to out/ as-is and run with
// whatever node is on PATH.

const USAGE = [
  "Usage:",
  "  node oc-subagent.js --agent <name> --description \"<label>\" --prompt \"<instructions>\" [--parent <ses_...>]",
  "  node oc-subagent.js --session <ses_...> --wait [--timeout <seconds>]   (poll for the answer)",
  "  node oc-subagent.js --session <ses_...> --text \"<new facts>\" [--wait]",
  "  node oc-subagent.js --session <ses_...> --abort",
  "  node oc-subagent.js --print-skill   (prints the SKILL.md that teaches these commands)",
].join("\n");

function parseArgs(argv) {
  const args = { agent: "general" };
  for (let i = 0; i < argv.length; i++) {
    const key = argv[i];
    const next = () => {
      i++;
      if (i >= argv.length) fail(`Missing value for ${key}`);
      return argv[i];
    };
    if (key === "--agent") args.agent = next();
    else if (key === "--description") args.description = next();
    else if (key === "--prompt") args.prompt = next();
    else if (key === "--session") args.session = next();
    else if (key === "--text") args.text = next();
    else if (key === "--parent") args.parent = next();
    else if (key === "--timeout") args.timeout = Number(next());
    else if (key === "--wait") args.wait = true;
    else if (key === "--abort") args.abort = true;
    else if (key === "--print-skill") args.printSkill = true;
    else fail(`Unknown argument ${key}\n${USAGE}`);
  }
  return args;
}

function fail(message) {
  process.stderr.write(`[oc-subagent] ${message}\n`);
  process.exit(1);
}

// Compact duration for status lines: 95 -> "1m35s", 3725 -> "1h2m5s".
function fmtDur(secs) {
  secs = Math.max(0, Math.floor(secs));
  const parts = [];
  for (const [div, unit] of [[86400, "d"], [3600, "h"], [60, "m"], [1, "s"]]) {
    const v = Math.floor(secs / div);
    if (v) {
      parts.push(`${v}${unit}`);
      secs %= div;
    }
  }
  return parts.join("") || "0s";
}

// The session whose turn is running this stub. The model may pass it; else
// the parent is the most recently updated session — its step bumps the
// timestamp continuously, and no other session should be moving while this
// bash call runs it. Best effort: a miss only leaves parentID unset.
async function newestBusySession(call) {
  try {
    const list = await call("GET", "/api/session?limit=20");
    const rows = (list.json?.data ?? []).filter((s) => !s.parentID);
    rows.sort((a, b) => (b.time?.updated ?? 0) - (a.time?.updated ?? 0));
    const top = rows[0];
    return top && Date.now() - (top.time?.updated ?? 0) < 60_000
      ? top.id
      : undefined;
  } catch {
    return undefined;
  }
}

// Watch the v2 stream for the sub-agent's turn end. `session.idle` for the
// child means the turn loop has exited, so the answer can be fetched the
// moment the sub-agent finishes instead of after a stability window. A
// stream that never connects or drops just leaves the poll loop in charge.
function watchIdle(base, childId, onIdle) {
  const ctrl = new AbortController();
  fetch(base + "/api/event", { signal: ctrl.signal })
    .then(async (res) => {
      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let buf = "";
      for (;;) {
        const { done, value } = await reader.read();
        if (done) return;
        buf += decoder.decode(value, { stream: true });
        let at;
        while ((at = buf.indexOf("\n")) >= 0) {
          const line = buf.slice(0, at).trim();
          buf = buf.slice(at + 1);
          if (!line.startsWith("data:")) continue;
          try {
            const frame = JSON.parse(line.slice(5));
            const d = frame.data ?? frame.properties ?? {};
            const type = frame.type ?? "";
            // v2 turns end with a step.ended whose finish is "stop" (no
            // idle event); v1 turns end with session.idle.
            const ended =
              /(^|\.)idle$/.test(type) ||
              (type === "session.next.step.ended" && d.finish === "stop");
            if (d.sessionID === childId && ended) onIdle();
          } catch {
            // A partial or foreign frame — the poll loop is the safety net.
          }
        }
      }
    })
    .catch(() => {});
  return () => ctrl.abort();
}

// One line saying what the child is doing, so the CALLING agent can judge
// whether it is stuck. Best effort: any fetch failing degrades to the bare
// still-working line. Pending asks come first — they are actionable in the
// UI, not stuckness.
async function workStatus(call, childId) {
  const now = Date.now();
  const bits = [];
  try {
    const page = await call("GET", `/api/session/${childId}/message?limit=5`);
    const rows = page.json?.data ?? [];
    const lastUser = [...rows].reverse().find((r) => r.type === "user");
    if (lastUser?.time?.created)
      bits.push(`turn ${fmtDur((now - lastUser.time.created) / 1000)}`);
    let lastSeen = 0;
    let running;
    for (const r of rows) {
      lastSeen = Math.max(lastSeen, r.time?.updated ?? r.time?.created ?? 0);
      for (const p of r.parts ?? []) {
        if (p.type === "tool" && p.state?.status === "running") {
          const start = p.state.time?.start ?? lastSeen;
          running = `${p.tool} ${fmtDur((now - start) / 1000)}`;
        }
      }
    }
    if (running) bits.push(`tool: ${running}`);
    if (lastSeen) bits.push(`last output ${fmtDur((now - lastSeen) / 1000)} ago`);
  } catch {
    // Status detail is optional.
  }
  let ask;
  try {
    const asks = await Promise.all([
      call("GET", `/api/session/${childId}/permission`),
      call("GET", `/api/session/${childId}/question`),
      call("GET", "/question"),
    ]);
    if ((asks[0].json?.data ?? []).length > 0) ask = "permission decision";
    else if (
      (asks[1].json?.data ?? []).some((q) => q.sessionID === childId) ||
      (asks[2].json ?? []).some((q) => q.sessionID === childId)
    )
      ask = "answer";
  } catch {
    // A pending ask that cannot be confirmed reads as plain work.
  }
  const head = ask
    ? `[waiting on a ${ask} — answer it in the UI]`
    : "[still working]";
  return [
    `${head} ${bits.join(" · ")}`.trim(),
    "Poll again with --wait, relay facts with --text, or abort with --abort.",
  ].join(" — ");
}

// Poll until the sub-agent's turn is over, then print its final text. The
// zhipuai endpoint completes an assistant row per STEP — intermediate steps
// carry text ("I'll run these…") and tool rows, so "first completed row"
// grabs a preamble. Normally the newest row must stay unchanged through a
// stability window (five polls); once the idle watcher has seen the turn
// end, the first completed row is accepted on sight. `after` (a local
// timestamp) restricts the answer to a turn STARTED after that moment — a
// relayed --text must not race back the previous turn's answer while the
// steered turn is still spinning up. Returns false when the deadline hits
// (the caller prints the work status); exits 1 on a failed turn.
async function waitForAnswer(call, base, childId, deadline, after) {
  const POLLS = 2_000;
  const STABLE = 5;
  let stableFor = 0;
  let fingerprint = "";
  let idleSeen = false;
  let wake = null;
  const stopWatching = watchIdle(base, childId, () => {
    if (!idleSeen) {
      idleSeen = true;
      if (wake) wake();
    }
  });
  try {
    while (Date.now() < deadline) {
      await new Promise((r) => {
        wake = r;
        setTimeout(r, idleSeen ? 250 : POLLS);
      });
      wake = null;
      const page = await call("GET", `/api/session/${childId}/message?limit=5`);
      const rows = page.json?.data ?? [];
      const assistant = rows.find((r) => r.type === "assistant");
      if (!assistant) continue;
      const created = assistant.time?.created ?? 0;
      if (after && created < after) {
        fingerprint = "";
        stableFor = 0;
        continue;
      }
      if (assistant.error) {
        const detail = assistant.error?.data?.message || assistant.error?.name || "unknown error";
        fail(`Sub-agent turn failed: ${detail}`);
      }
      if (!assistant.time?.completed) {
        fingerprint = "";
        stableFor = 0;
        continue;
      }
      const mark = `${rows.length}:${assistant.id}:${assistant.time.completed}`;
      // With the stop signal seen the row is final (step.ended arrives
      // after text.ended) — accept it on first sight; without, hold it
      // through the stability window first.
      if (mark !== fingerprint && !idleSeen) {
        fingerprint = mark;
        stableFor = 0;
        continue;
      }
      stableFor += 1;
      if (stableFor < STABLE && !idleSeen) continue;
      const text = (assistant.content ?? [])
        .filter((p) => p.type === "text")
        .map((p) => p.text)
        .join("\n")
        .trim();
      process.stdout.write(text || "(sub-agent finished without a reply)");
      process.stdout.write("\n");
      return true;
    }
  } finally {
    stopWatching();
  }
  return false;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.printSkill) {
    process.stdout.write(skillMarkdown(__filename));
    return;
  }
  if (args.session) {
    if (args.description || args.prompt)
      fail(`--session takes no --agent/--description/--prompt\n${USAGE}`);
    if (args.abort && (args.text || args.wait))
      fail(`--abort takes no --text/--wait\n${USAGE}`);
  } else if (!args.description || !args.prompt) {
    fail(`--description and --prompt are required (or pass --session)\n${USAGE}`);
  }
  if (args.text && !args.session) fail(`--text needs --session\n${USAGE}`);
  if ((args.wait || args.abort) && !args.session)
    fail(`--wait/--abort need --session\n${USAGE}`);
  // The bare old form --session <id> re-attaches: same as --wait.
  if (args.session && !args.text && !args.abort) args.wait = true;

  const port = process.env.OPENCODE_GUI_PORT;
  if (!port) fail("OPENCODE_GUI_PORT is not set — run this from an opencode session started by the OpenCode GUI extension.");
  const base = `http://localhost:${port}`;

  const call = async (method, path, body) => {
    let res;
    try {
      res = await fetch(base + path, {
        method,
        headers: body === undefined ? undefined : { "content-type": "application/json" },
        body: body === undefined ? undefined : JSON.stringify(body),
      });
    } catch (err) {
      throw new Error(`Cannot reach the OpenCode server at ${base}: ${err.message}`);
    }
    const text = await res.text();
    let json;
    try {
      json = JSON.parse(text);
    } catch {
      throw new Error(`Server returned non-JSON ${res.status} for ${method} ${path}`);
    }
    return { status: res.status, ok: res.ok, json };
  };

  // One poll waits at most this long; the calling agent chains polls.
  const DEFAULT_TIMEOUT_S = 60;
  const timeoutS =
    Number.isFinite(args.timeout) && args.timeout > 0
      ? args.timeout
      : DEFAULT_TIMEOUT_S;

  // Abort mode: kill the child session's turn. Its session survives; a
  // later --text can still start a new one.
  if (args.abort) {
    const res = await call("POST", `/session/${args.session}/abort`);
    if (!res.ok) fail(`Could not abort the sub-agent session (HTTP ${res.status}).`);
    process.stdout.write(`Aborted sub-agent session ${args.session}.\n`);
    return;
  }

  // Relay mode: queue facts into an existing sub-agent — the prompt lands in
  // the session stream at once and its running loop reads the stream again
  // at its next step boundary, so a busy child takes the facts mid-turn
  // (steering); an idle one starts a new turn. With --wait, poll for the
  // answer that follows the relay — only a row created after the send counts.
  if (args.text !== undefined) {
    const sent = await call("POST", `/api/session/${args.session}/prompt`, {
      prompt: { text: args.text },
    });
    if (!sent.ok) fail(`Could not send to the sub-agent session (HTTP ${sent.status}).`);
    if (!args.wait) {
      process.stdout.write(`Facts queued for the sub-agent (session ${args.session}) — a busy one takes them at its next step; an idle one answers now.`);
      process.stdout.write("\n");
      return;
    }
    const answered = await waitForAnswer(
      call,
      base,
      args.session,
      Date.now() + timeoutS * 1000,
      Date.now(),
    );
    if (!answered) process.stdout.write(await workStatus(call, args.session) + "\n");
    return;
  }

  // Poll mode: collect what a spawned sub-agent is doing — its answer when
  // the turn has ended (a finished child reprints it), a status line
  // otherwise.
  if (args.wait) {
    const answered = await waitForAnswer(
      call,
      base,
      args.session,
      Date.now() + timeoutS * 1000,
      undefined,
    );
    if (!answered) process.stdout.write(await workStatus(call, args.session) + "\n");
    return;
  }

  // Spawn mode: a real session row, titled the way the server titles its own
  // spawns so the chip's resolver and Home's filtering recognize it, linked
  // to the parent (agent and parentID only persist together), and created as
  // the requested agent so the turn actually runs that subagent. Returns
  // immediately — the calling agent polls with --wait.
  const parentId = args.parent ?? (await newestBusySession(call));
  const created = await call("POST", "/session", {
    title: `${args.description} (@${args.agent} subagent)`,
    agent: args.agent,
    ...(parentId ? { parentID: parentId } : {}),
  });
  const childId = created.json?.id ?? created.json?.data?.id;
  if (!created.ok || !childId) fail(`Could not create the sub-agent session (HTTP ${created.status}).`);

  process.stdout.write(`[sub-agent session: ${childId}] started — it runs on its own; your turn continues.\n`);

  const prompted = await call("POST", `/api/session/${childId}/prompt`, {
    prompt: { text: args.prompt },
  });
  if (!prompted.ok) fail(`Could not start the sub-agent turn (HTTP ${prompted.status}).`);
  process.stdout.write(`Poll for its result: node "${__filename}" --session ${childId} --wait\n`);
}

// The skill the extension installs into ~/.config/opencode/skills/oc-task —
// kept here so the command template and this script can never drift apart.
function skillMarkdown(stubPath) {
  const p = String(stubPath).replace(/\\/g, "/");
  return `---
name: oc-task
description: Spawn a sub-agent that works in its own session and returns its result. Use this whenever the user asks to run a sub-agent/subagent, delegate work to an agent, or run a side task. Never use \`opencode run\` for this.
---

Delegate work to a sub-agent by running this exact command with the bash tool.
This script is the ONLY delegation mechanism: never use the built-in \`task\` tool
(a finished sub-agent does not resume the main thread there) and never use
\`opencode run\` or the CLI.

    node "${p}" --agent <agent-name> --description "<short label>" --prompt "<full task instructions>"

- \`--agent\`: the agent to run as the sub-agent (for example \`general\`, or any configured agent name). Defaults to \`general\` when omitted.
- \`--description\`: a 2-6 word label naming the task; it is shown on the sub-agent chip in the UI.
- \`--prompt\`: complete, self-contained instructions. The sub-agent sees nothing except this prompt, so include every detail it needs.
- \`--parent\`: attach to a specific parent session instead of auto-picking the newest busy one (pass its \`ses_…\` id).
- The command starts the sub-agent and returns immediately — your own turn stays free. It prints "[sub-agent session: ses_…]" first: keep that id.
- Delegate ANY operation that would block your turn for minutes (test suites, builds, installs): prompt the sub-agent to run it and report the output, then collect the result as below.

Then poll for the result, repeating until it prints the sub-agent's answer:

    node "${p}" --session <ses_…> --wait [--timeout <seconds>]

Each poll waits up to \`--timeout\` seconds (default 60) and prints either the
sub-agent's answer or a one-line status: how long its turn has run, its current
tool, pending permission/question asks, and time since its last output. YOU judge
from that status whether it is stuck — keep polling, send new facts, or abort.
- To send the sub-agent new facts while it works or after it finished (the user added instructions, or you reconsidered), run:
      node "${p}" --session <ses_…> --text "<the new facts, relayed faithfully>" --wait
  The facts join the sub-agent's queue: a working sub-agent receives them the moment its current turn ends, a finished one starts a new turn. \`--wait\` then polls for that fresh answer; drop it to queue facts without waiting.
- To stop a wedged or wrong-headed sub-agent:
      node "${p}" --session <ses_…> --abort
  Only the child session stops; report the failure and continue yourself.
- To run several sub-agents in parallel, start several in one step, then poll each.
- Never delegate with the built-in \`task\` tool, \`opencode run\`, or the CLI — always use this script.
`;
}

main().catch((err) => fail(err?.stack || String(err)));
