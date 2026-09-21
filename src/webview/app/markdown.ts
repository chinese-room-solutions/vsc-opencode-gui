// Markdown → sanitized HTML. Host- and model-authored text must never inject
// markup, so every render goes through DOMPurify before it touches the DOM.
import { marked } from "marked";
import DOMPurify from "dompurify";
import hljs from "highlight.js/lib/common";
import { postToHost } from "./host";

const escapeHtml = (s: string) =>
  s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

const decodeSafe = (s: string) => {
  try {
    return decodeURIComponent(s);
  } catch {
    return s;
  }
};

// Past this many chars a block's body skips highlight.js (and the host
// tokenize in enhanceCodeBlocks below) and keeps the escaped paint:
// highlighting is per-character work, and a huge untagged fence would run
// highlightAuto's grammar sweep over it — enough to kill the renderer.
const CODE_HL_MAX = 16_384;

marked.use({
  gfm: true,
  breaks: true,
  renderer: {
    code({ text, lang }: { text: string; lang?: string }): string {
      const name = (lang ?? "").trim().split(/\s+/)[0];
      let body: string;
      try {
        body =
          text.length > CODE_HL_MAX
            ? escapeHtml(text)
            : name && hljs.getLanguage(name)
              ? hljs.highlight(text, { language: name }).value
              : hljs.highlightAuto(text).value;
      } catch {
        body = escapeHtml(text);
      }
      return `<pre><code class="hljs${name ? ` language-${name}` : ""}">${body}</code></pre>`;
    },
  },
});

export function renderMarkdown(text: string): string {
  const html = marked.parse(text, { async: false });
  return DOMPurify.sanitize(html, {
    // Class names survive so hljs spans and our own markers keep working.
    ADD_ATTR: ["target"],
  });
}

// Copy affordance for fenced blocks. The markup mirrors the app's
// CopyIcon/CheckIcon (icons.tsx); injected via DOM APIs after sanitize.
const COPY_ICON =
  '<svg width="13" height="13" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linejoin="round" aria-hidden="true"><rect x="5.5" y="5.5" width="8" height="8" rx="1.6"/><path d="M10.5 3.5h-6a2 2 0 0 0-2 2v6"/></svg>';
const CHECK_ICON =
  '<svg width="13" height="13" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M3 8.6 6.4 12 13 4.6"/></svg>';

// The shared copy control: copy glyph that flips to a check for a beat
// after writing `text`. Fenced blocks and blockquotes.
function copyButton(text: string, label: string): HTMLButtonElement {
  const btn = document.createElement("button");
  btn.type = "button";
  btn.className = "code-copy";
  btn.title = label;
  btn.setAttribute("aria-label", label);
  btn.innerHTML = COPY_ICON;
  btn.addEventListener("click", () => {
    void navigator.clipboard.writeText(text).catch(() => {});
    btn.classList.add("done");
    btn.innerHTML = CHECK_ICON;
    window.setTimeout(() => {
      btn.classList.remove("done");
      btn.innerHTML = COPY_ICON;
    }, 1200);
  });
  return btn;
}

// Blocks up to this many lines copy in place (modifier+click) — selecting
// text in them is more effort than the copy is worth.
const COPY_MAX_LINES = 10;

// The modifier for click-to-copy: opencodeGui.codeCopyModifier, baked in by
// AppHost and pushed live as "copy-modifier" messages (store.hostMessage).
type CopyModifier = "alt" | "ctrl" | "meta" | "shift";
const MOD_PROP: Record<CopyModifier, "altKey" | "ctrlKey" | "metaKey" | "shiftKey"> = {
  alt: "altKey",
  ctrl: "ctrlKey",
  meta: "metaKey",
  shift: "shiftKey",
};
const MOD_LABEL: Record<CopyModifier, string> = {
  alt: "Alt",
  ctrl: "Ctrl",
  meta: "⌘",
  shift: "Shift",
};
const MODS: readonly CopyModifier[] = ["alt", "ctrl", "meta", "shift"];
let copyModifier: CopyModifier = (() => {
  const baked = document
    .querySelector('meta[name="opencode-copy-modifier"]')
    ?.getAttribute("content") as CopyModifier | undefined;
  return baked && MODS.includes(baked) ? baked : "alt";
})();

export function setCopyModifier(value: string): void {
  if (MODS.includes(value as CopyModifier)) copyModifier = value as CopyModifier;
}

// Cmd+click copies on macOS whatever the setting says — the platform's
// natural modifier — riding alongside the configured key (default
// Alt/Option). Everywhere else only the configured key counts.
const IS_MAC = /Mac/i.test(navigator.platform);
const modHit = (e: MouseEvent) =>
  !!e[MOD_PROP[copyModifier]] || (IS_MAC && e.metaKey);
// The hover/hint label: on macOS name both working keys.
const modLabel = () => {
  if (!IS_MAC || copyModifier === "meta") return MOD_LABEL[copyModifier];
  return copyModifier === "alt"
    ? "⌘ or Option"
    : `⌘ or ${MOD_LABEL[copyModifier]}`;
};

// Adds a copy button to each fenced block, and asks the host for the
// editor-true tokenization (real TextMate grammar + theme colors) of every
// explicitly-tagged block — the reply replaces the highlight.js rendering.
// Re-runs on every re-render — streaming replaces the HTML wholesale, so a
// pending reply only applies if its block is still attached.
export function enhanceCodeBlocks(root: HTMLElement, tokenize = true): void {
  for (const pre of [...root.querySelectorAll<HTMLPreElement>("pre")]) {
    const codeEl = pre.querySelector("code");
    const code = codeEl?.textContent ?? "";
    if (!code) continue;
    const lang = /\blanguage-([\w+#-]+)/.exec(codeEl!.className ?? "")?.[1];
    // The copy button anchors to this wrapper, not the pre: the pre is the
    // horizontal scroll container, and a button inside it rides the scroll
    // off-screen on wide code. The wrapper's visible top-right stays put.
    let wrap = pre.parentElement;
    if (!wrap || !wrap.classList.contains("code-block")) {
      wrap = document.createElement("div");
      wrap.className = "code-block";
      pre.replaceWith(wrap);
      wrap.appendChild(pre);
    }
    // Skipped while streaming: the message HTML is replaced every delta, so
    // a tokenize reply lands between deltas and repaints finished lines in
    // the host palette just before the next delta reverts them to the
    // highlight.js paint — fast flicker. Blocks get the host paint once,
    // when the message completes. Oversized blocks never tokenize (same
    // cap as the renderer above — one span per token run is unbounded).
    if (tokenize && lang && codeEl && code.length <= CODE_HL_MAX) {
      const id = `${lang}:${hash(code)}`;
      requestTokenize(id, lang, code, (tokens) => {
        if (!codeEl.isConnected) return;
        // Runs become spans via element.style — CSP strips inline style
        // attributes, but CSSOM assignments are never governed by it.
        codeEl.textContent = "";
        for (const t of tokens) {
          if (!t.color && !t.shadow) {
            codeEl.appendChild(document.createTextNode(t.text));
            continue;
          }
          const span = document.createElement("span");
          span.textContent = t.text;
          if (t.color) span.style.color = t.color;
          if (t.shadow) span.style.textShadow = t.shadow;
          codeEl.appendChild(span);
        }
      });
    }
    // A re-run on unchanged HTML (the tokenize flip when the message
    // completes) finds the same wrapper — drop the stale button instead of
    // stacking a second one over it: a click then lit the check on one
    // while the other still showed the copy glyph.
    wrap.querySelector(".code-copy")?.remove();
    const btn = copyButton(code, "Copy code");
    // A small block copies in place: modifier+click or modifier+right-click
    // anywhere in it. The class guards the listeners against the same
    // re-run that re-appends the button. The pointer cursor rides the
    // mousemove's own modifier flag — key events only reach a focused
    // webview, so keydown tracking would miss the first hover.
    const lines = code.replace(/\n+$/, "").split("\n").length;
    if (lines <= COPY_MAX_LINES && !pre.classList.contains("code-small")) {
      pre.classList.add("code-small");
      pre.title = `${modLabel()}+click to copy`;
      pre.addEventListener("mousemove", (e) =>
        pre.classList.toggle("mod-hover", modHit(e)),
      );
      pre.addEventListener("mouseleave", () =>
        pre.classList.remove("mod-hover"),
      );
      const modCopy = (e: MouseEvent) => {
        if (!modHit(e)) return;
        e.preventDefault();
        btn.click();
      };
      pre.addEventListener("click", modCopy);
      pre.addEventListener("contextmenu", modCopy);
    }
    wrap.appendChild(btn);
  }
}

// Transcript selection copies are rewritten as clean plain text plus a
// structural HTML flavor. Chromium's default HTML payload bakes every
// element's computed styles into the fragment — theme colors, the code
// block's background dump — and rich paste targets inherit them or choke
// on the nesting: colored prose, gray code slabs. The rewrite keeps the
// structure (paragraphs, pre, code, lists, links) and drops every style
// and class, so the paste takes the target's own formatting: formatting
// only, never colors. Editables (composer) keep the native behavior.
const COPY_STRIP = "style, script, button, svg, .code-copy";

export function initTranscriptCopy(): void {
  document.addEventListener("copy", (e: ClipboardEvent) => {
    const sel = document.getSelection();
    if (!sel || sel.rangeCount === 0 || sel.isCollapsed) return;
    const range = sel.getRangeAt(0);
    const scope = (n: Node | null): Element | null => {
      const el = n instanceof Element ? n : n?.parentElement ?? null;
      return el?.closest(".msgs") ?? null;
    };
    const start = scope(range.startContainer);
    if (!start || start !== scope(range.endContainer)) return;
    // A range inside a code block clones bare token spans — no pre, so
    // targets that flow text would collapse the newlines again. Wrap the
    // fragment in the block's own pre (attribute-free) in that case.
    const common =
      range.commonAncestorContainer instanceof Element
        ? range.commonAncestorContainer
        : range.commonAncestorContainer.parentElement;
    const pre = common?.closest("pre");
    const box = pre?.cloneNode(false) as HTMLElement | null ?? document.createElement("div");
    box.appendChild(range.cloneContents());
    box.querySelectorAll(COPY_STRIP).forEach((el) => el.remove());
    for (const el of [box, ...box.querySelectorAll("*")]) {
      for (const attr of [...el.attributes]) {
        if (attr.name !== "href") el.removeAttribute(attr.name);
      }
    }
    e.preventDefault();
    e.clipboardData?.setData("text/plain", sel.toString());
    e.clipboardData?.setData("text/html", pre ? box.outerHTML : box.innerHTML);
  });
}

// Copy affordance for blockquotes: the same control as fenced blocks,
// revealed on hover at the block's top right; copies the quoted text.
export function enhanceBlockquotes(root: HTMLElement): void {
  for (const bq of [...root.querySelectorAll<HTMLElement>("blockquote")]) {
    const text = (bq.textContent ?? "").trim();
    if (!text) continue;
    bq.querySelector(".code-copy")?.remove();
    bq.appendChild(copyButton(text, "Copy quote"));
  }
}

// Inline code spans (including file refs) copy their text on modifier+click
// — `hello.go` in prose is exactly what one wants to grab. File refs keep
// their plain-click open; the copy click stops propagation so it never
// opens. The span pulses green as the confirmation (nothing to anchor a
// tag to). The class guards the listeners against enhancer re-runs.
export function enhanceInlineCode(root: HTMLElement): void {
  for (const el of root.querySelectorAll<HTMLElement>("code:not(pre code)")) {
    if (el.classList.contains("code-inline") || !el.textContent) continue;
    el.classList.add("code-inline");
    const text = el.textContent;
    el.addEventListener("mousemove", (e) =>
      el.classList.toggle("mod-hover", modHit(e)),
    );
    el.addEventListener("mouseleave", () => el.classList.remove("mod-hover"));
    el.addEventListener("click", (e) => {
      if (!modHit(e)) return;
      e.preventDefault();
      e.stopPropagation();
      void navigator.clipboard.writeText(text).catch(() => {});
      el.classList.remove("copied-flash");
      void el.offsetWidth; // restart the pulse on back-to-back copies
      el.classList.add("copied-flash");
      window.setTimeout(() => el.classList.remove("copied-flash"), 1200);
    });
  }
}

// Replies for tokenize requests, keyed by language+content so re-renders of
// the same block reuse the entry instead of accumulating. The host always
// answers (tokens, or null when the language has no grammar — null keeps the
// highlight.js paint).
const tokenizeReplies = new Map<string, (tokens: TokenRun[]) => void>();
let tokenizeListening = false;

interface TokenRun {
  text: string;
  color?: string;
  shadow?: string;
}

function hash(s: string): string {
  let h = 5381;
  for (let i = 0; i < s.length; i++) h = ((h << 5) + h + s.charCodeAt(i)) | 0;
  return (h >>> 0).toString(36);
}

function requestTokenize(
  id: string,
  lang: string,
  code: string,
  apply: (tokens: TokenRun[]) => void,
): void {
  if (!tokenizeListening) {
    tokenizeListening = true;
    window.addEventListener("message", (e) => {
      const m = e.data as { type?: string; id?: string; tokens?: TokenRun[] | null };
      if (m?.type === "tokenized" && typeof m.id === "string") {
        const apply = tokenizeReplies.get(m.id);
        tokenizeReplies.delete(m.id);
        if (Array.isArray(m.tokens)) apply?.(m.tokens);
      }
    });
  }
  tokenizeReplies.set(id, apply);
  postToHost({ type: "tokenize", id, lang, code });
}

// The way models cite files: `path.ext`, `path.ext:line`,
// `path.ext:line-line`. A bare single-word code span without a separator is
// left alone (symbols, keywords).
const FILE_REF_RE = /^([\w./@\-]+\.\w+)(?::(\d+)(?:-(\d+)|:(\d+))?)?$/;

interface FileRef {
  path: string;
  line?: string;
  endLine?: string;
}

export function parseFileRef(text: string): FileRef | undefined {
  const m = FILE_REF_RE.exec(text.trim());
  if (!m) return undefined;
  const hasSep = /[\/]/.test(m[1]) || !!m[2];
  if (!hasSep) return undefined;
  return { path: m[1], line: m[2], endLine: m[3] || m[4] };
}

// Tag file-ref code spans (not fenced blocks) and self-referential links so
// a delegated click handler can turn them into open-file requests.
export function tagFileRefs(root: HTMLElement): void {
  for (const el of root.querySelectorAll<HTMLElement>("code:not(pre code)")) {
    const ref = parseFileRef(el.textContent ?? "");
    if (ref) {
      el.classList.add("file-ref");
      el.dataset.path = ref.path;
      if (ref.line) el.dataset.line = ref.line;
      if (ref.endLine) el.dataset.endLine = ref.endLine;
    }
  }
  for (const a of root.querySelectorAll<HTMLAnchorElement>("a[href]")) {
    const href = a.getAttribute("href") ?? "";
    if (!/^https?:/.test(href)) {
      const ref = parseFileRef(decodeSafe(href.replace(/^\.?\//, "")));
      if (ref) {
        a.classList.add("file-ref");
        a.removeAttribute("href");
        a.dataset.path = ref.path;
        if (ref.line) a.dataset.line = ref.line;
        if (ref.endLine) a.dataset.endLine = ref.endLine;
      }
    }
  }
}

