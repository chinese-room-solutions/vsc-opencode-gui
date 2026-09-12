import { useEffect, useRef, useState } from "preact/hooks";
import { useSignalEffect } from "@preact/signals";
import type { PermissionRequest, QuestionRequest } from "../api";
import {
  answerPermission,
  answerQuestion,
  dismissQuestion,
  pendingPermissions,
  pendingQuestions,
  popover,
  refreshPermissions,
  refreshQuestions,
  setPopover,
} from "../store";

// Docks above the composer for this session's pending permission requests
// and questions. Keyboard: Up/Down move the option cursor, Enter confirms,
// Left/Right switch questions, Backspace clears the pick, Esc dismisses
// (rejects). No portal — a capture-phase window listener outruns the
// composer and only exists while a dock is pending; it steps aside for
// typing in inputs.

// Up/Down move, Enter confirms (with the active index), Esc dismisses; a
// question dock adds Left/Right for questions and Backspace to unselect; a
// permission dock adds digit shortcuts for its numbered choices and starts
// with the first row selected. The active index lives in a ref the handler
// updates synchronously, so a quick Enter after an arrow never confirms a
// stale option. Nothing is highlighted until moved (arrow or the returned
// mover — a dock may let the mouse select). Typing anywhere keeps its keys
// — digits and arrows must never hijack the composer or a dock input — but
// Escape still cancels the pending dock from the composer: it is the
// modal's way out (a target inside a dock input keeps Escape for itself).
function useDockKeys(opts: {
  count: number;
  onConfirm: (active: number) => void;
  onDismiss: () => void;
  onBackspace?: () => void;
  onPrev?: () => void;
  onNext?: () => void;
  onDigit?: (n: number) => void;
  start?: number;
}): [number | null, (to: number) => void] {
  const [active, setActive] = useState<number | null>(opts.start ?? null);
  const cur = useRef(opts.start ?? 0);
  const move = (to: number) => {
    cur.current = to;
    setActive(to);
  };
  // The callbacks are inline arrows at the call sites — new identity every
  // render. Held in a ref so the window listener subscribes once per count,
  // not once per render (typing in the dock input would resubscribe it on
  // every keystroke otherwise); each keystroke reads the latest set.
  const latest = useRef(opts);
  latest.current = opts;
  useEffect(() => {
    if (opts.count === 0) return;
    const handler = (e: KeyboardEvent) => {
      const { count, onConfirm, onDismiss, onBackspace, onPrev, onNext, onDigit } =
        latest.current;
      const t = e.target as HTMLElement | null;
      const typing = t && (t.tagName === "INPUT" || t.tagName === "TEXTAREA");
      if (typing && !(e.key === "Escape" && !t.closest(".dock"))) return;
      const take = () => {
        e.preventDefault();
        e.stopPropagation();
      };
      if (e.key === "ArrowDown") {
        take();
        move(Math.min(cur.current + 1, count - 1));
      } else if (e.key === "ArrowUp") {
        take();
        move(Math.max(cur.current - 1, 0));
      } else if (e.key === "ArrowLeft" && onPrev) {
        take();
        onPrev();
      } else if (e.key === "ArrowRight" && onNext) {
        take();
        onNext();
      } else if (e.key === "Backspace" && onBackspace) {
        take();
        onBackspace();
      } else if (e.key === "Enter") {
        take();
        onConfirm(Math.min(cur.current, count - 1));
      } else if (e.key === "Escape") {
        take();
        onDismiss();
      } else if (onDigit && /^[1-9]$/.test(e.key)) {
        take();
        onDigit(Number(e.key));
      }
    };
    window.addEventListener("keydown", handler, true);
    return () => window.removeEventListener("keydown", handler, true);
  }, [opts.count]);
  return [active, move];
}

// Claude Code's permission card: "Allow this <action>?" over the resource
// itself (for bash the command line), then the answers stacked and numbered
// — Yes, and "Yes, and don't ask again" when the server remembers one — with
// a reject line that carries an optional redirect message. One selection,
// an accent fill that starts on Yes and follows the arrows or the mouse;
// Enter or a click commits it. Several asks pending at once compose into one
// dock, questions-style: a tab per ask up top, one ask at a time, the
// redirect draft kept per tab; an answer drops its tab and the dock lands on
// the next pending one.
function PermissionDock(props: { perms: PermissionRequest[] }) {
  const perms = props.perms;
  const [step, setStep] = useState(0);
  const [messages, setMessages] = useState<string[]>([]);
  const i = Math.min(step, perms.length - 1);
  const p = perms[i];
  const message = messages[i] ?? "";
  const setMessage = (m: string) =>
    setMessages(perms.map((_, k) => (k === i ? m : messages[k] ?? "")));
  const replies: ("once" | "always" | "reject")[] = p.save.length
    ? ["once", "always", "reject"]
    : ["once", "reject"];
  const fire = (reply: "once" | "always" | "reject") =>
    void answerPermission(
      p.sessionID,
      p.id,
      reply,
      reply === "reject" && message.trim() ? message.trim() : undefined,
    );
  const [active, move] = useDockKeys({
    count: replies.length,
    start: 0,
    onConfirm: (n) => fire(replies[n]),
    onDismiss: () => fire("reject"),
    onDigit: (n) => {
      if (n <= replies.length) fire(replies[n - 1]);
    },
    onPrev: i > 0 ? () => setStep(i - 1) : undefined,
    onNext: i < perms.length - 1 ? () => setStep(i + 1) : undefined,
  });
  // Tab label: a short slug of the resource — for bash, the command's head.
  const tab = (r: PermissionRequest) => {
    const line = r.resources[0] ?? r.action;
    return line.length > 24 ? line.slice(0, 23) + "…" : line;
  };
  return (
    <div class="dock permission" data-testid="permission-dock">
      <div class="dock-tabs">
        {perms.map((r, k) => (
          <button
            key={r.id}
            class={"dock-tab" + (k === i ? " active" : "")}
            onClick={() => setStep(k)}
          >
            {tab(r)}
          </button>
        ))}
      </div>
      <div class="dock-text">Allow this {p.action}?</div>
      {p.resources.length > 0 && <pre class="dock-cmd">{p.resources.join("\n")}</pre>}
      <span class="dock-choices">
        {replies.map((r, n) => (
          <button
            key={r}
            type="button"
            class={"dock-choice" + (active === n ? " active" : "")}
            onMouseEnter={() => move(n)}
            onClick={() => fire(r)}
          >
            <span class="dock-num">{n + 1}</span>
            {r === "once" ? "Yes" : r === "always" ? "Yes, and don't ask again" : "No"}
          </button>
        ))}
        <input
          class="dock-input"
          placeholder="Tell it what to do instead..."
          value={message}
          onInput={(e) => setMessage(e.currentTarget.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && message.trim()) {
              e.preventDefault();
              fire("reject");
            }
          }}
        />
      </span>
      <div class="dock-hint">Esc to cancel</div>
    </div>
  );
}

// One request may carry several questions, asked one at a time (Claude
// Code's flow): a tab per question up top, pick or write an answer, the
// dock advances. A single-select pick advances by itself — after a short
// confirming flash — except on the last question, where Enter on the
// already-picked row or the Submit button sends the request. Answers are
// label arrays aligned with `questions`; every question accepts free text
// unless it carries an explicit `custom: false` (the server omits the flag
// — absent means true; only builtin asks like plan_exit send false);
// `multiple` questions toggle and advance via the button.
function QuestionDock(props: { q: QuestionRequest }) {
  const q = props.q;
  const [step, setStep] = useState(0);
  const [picked, setPicked] = useState<string[][]>(() =>
    q.questions.map(() => []),
  );
  const [custom, setCustom] = useState<string[]>(() =>
    q.questions.map(() => ""),
  );
  const [flash, setFlash] = useState<string>();
  const flashTimer = useRef(0);

  const qi = q.questions[step];
  const last = step === q.questions.length - 1;
  const multi = qi.multiple === true;
  const answeredAt = (i: number) =>
    picked[i].length > 0 || custom[i].trim() !== "";
  const allAnswered = q.questions.every((_, i) => answeredAt(i));

  const answer = (p: string[][], c: string[]) =>
    q.questions.map((_, i) => [...p[i], ...(c[i].trim() ? [c[i].trim()] : [])]);
  const submit = (p: string[][], c: string[]) =>
    void answerQuestion(q.sessionID, q.id, answer(p, c), q.v1 === true);
  // Forward one question; on the last one the request submits — but only
  // once every question carries an answer (free tab navigation can leave
  // earlier ones empty).
  const advance = () => {
    if (!last) setStep(step + 1);
    else if (allAnswered) submit(picked, custom);
  };
  // Flash the picked row, then advance — the confirming beat before the
  // next question replaces the row.
  const flashAdvance = (label: string) => {
    const from = step;
    setFlash(label);
    clearTimeout(flashTimer.current);
    flashTimer.current = window.setTimeout(() => {
      setFlash(undefined);
      // The user may have tabbed away mid-flash — advance only if the
      // flashed question is still on screen.
      setStep((s) => (s === from ? s + 1 : s));
    }, 300);
  };

  // Apply the pick: single-select replaces (radio), multiple toggles.
  // Returns whether the answer changed.
  const pick = (label: string): boolean => {
    const cur = picked[step].includes(label);
    setPicked(
      picked.map((labels, i) => {
        if (i !== step) return labels;
        if (multi)
          return cur ? labels.filter((l) => l !== label) : [...labels, label];
        // Single-select is a radio: a pick always answers (clicking the
        // already-picked row re-confirms, never un-answers).
        return [label];
      }),
    );
    if (!multi && !cur && !last) flashAdvance(label);
    return !multi ? !cur : true;
  };
  // Enter on the row under the cursor picks it — or, if it is already the
  // answer, confirms (advance; on the last question, submit).
  const confirm = (label: string) => {
    if (!pick(label)) advance();
  };
  const [active] = useDockKeys({
    count: qi.options.length,
    onConfirm: (i) =>
      confirm(qi.options[Math.min(i, qi.options.length - 1)].label),
    onDismiss: () => void dismissQuestion(q.sessionID, q.id, q.v1 === true),
    onBackspace: () =>
      setPicked(picked.map((labels, i) => (i === step ? [] : labels))),
    onPrev: step > 0 ? () => setStep(step - 1) : undefined,
    onNext: last ? undefined : () => setStep(step + 1),
  });

  // One choice row, Claude Code style: a radio/checkbox mark, then label
  // over a muted description. The pick lives in the mark; the row fill is
  // only the cursor/hover highlight.
  const row = (o: { label: string; description?: string }, j: number) => {
    const on = picked[step].includes(o.label);
    return (
      <button
        type="button"
        key={o.label}
        class={
          "dock-opt-row" +
          (active === j ? " active" : "") +
          (flash === o.label ? " confirming" : "")
        }
        onClick={() => pick(o.label)}
      >
        <span
          class={"dock-mark " + (multi ? "check" : "radio") + (on ? " on" : "")}
        />
        <span class="dock-opt-body">
          <span class="dock-opt-label">{o.label}</span>
          {o.description && <span class="dock-opt-desc">{o.description}</span>}
        </span>
      </button>
    );
  };

  return (
    <div class="dock question" data-testid="question-dock">
      <div class="dock-tabs">
        {q.questions.map((t, i) => (
          <button
            key={i}
            class={
              "dock-tab" +
              (i === step ? " active" : "") +
              (answeredAt(i) ? " answered" : "")
            }
            onClick={() => setStep(i)}
          >
            {t.header || i + 1}
          </button>
        ))}
      </div>
      <div class="dock-text">{qi.question}</div>
      <span class="dock-opts">
        {qi.options.map((o, j) => row(o, j))}
        {qi.custom !== false && (
          <input
            class="dock-input"
            placeholder="Other..."
            value={custom[step]}
            onInput={(e) =>
              setCustom(
                custom.map((c, k) =>
                  k === step ? e.currentTarget.value : c,
                ),
              )
            }
            onKeyDown={(e) => {
              if (e.key === "Enter" && custom[step].trim()) {
                e.preventDefault();
                advance();
              } else if (e.key === "Escape") {
                e.preventDefault();
                void dismissQuestion(q.sessionID, q.id, q.v1 === true);
              }
            }}
          />
        )}
      </span>
      <span class="dock-buttons">
        {step > 0 && (
          <button class="dock-back" onClick={() => setStep(step - 1)}>
            Back
          </button>
        )}
        <span class="dock-spacer" />
        {(multi || last) && (
          <button
            class="dock-submit"
            disabled={last ? !allAnswered : !answeredAt(step)}
            onClick={() => advance()}
          >
            {last ? "Submit" : "Next"}
          </button>
        )}
        <button
          class="dock-dismiss"
          onClick={() => void dismissQuestion(q.sessionID, q.id, q.v1 === true)}
        >
          Dismiss
        </button>
      </span>
    </div>
  );
}

// Only the open session's requests dock above its composer; a draft has
// none of its own. A newly docked request closes any open picker or the
// ring's breakdown, so the buttons are never covered.
export function Docks(props: { sessionId?: string }) {
  const id = props.sessionId;
  // Discover a question or permission ask made while this view was closed
  // or reloaded: the list endpoints are per-session, so the open view
  // fetches both on mount.
  useEffect(() => {
    if (id) {
      void refreshQuestions(id);
      void refreshPermissions(id);
    }
  }, [id]);
  useSignalEffect(() => {
    const pending =
      pendingPermissions.value.length > 0 || pendingQuestions.value.length > 0;
    if (pending && popover.value) setPopover(undefined);
  });
  if (!id) return null;
  const perms = pendingPermissions.value.filter((p) => p.sessionID === id);
  const asks = pendingQuestions.value.filter((q) => q.sessionID === id);
  if (perms.length === 0 && asks.length === 0) return null;
  return (
    <div class="docks">
      {perms.length > 0 && <PermissionDock key={id} perms={perms} />}
      {asks.map((q) => (
        <QuestionDock key={q.id} q={q} />
      ))}
    </div>
  );
}
