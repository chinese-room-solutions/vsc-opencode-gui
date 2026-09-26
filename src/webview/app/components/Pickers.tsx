import { useEffect, useRef, useState } from "preact/hooks";
import type { Agent, ModelSelection } from "../api";
import { CheckIcon, ChevronIcon, SearchIcon, SlidersIcon } from "../icons";
import { postToHost } from "../host";
import { tileFor } from "../tile";
import {
  agents,
  currentSelection,
  defaultAgent,
  displayModel,
  hiddenModels,
  modelFree,
  modelLabel,
  modelVariants,
  popover,
  providers,
  setPopover,
  setSelection,
} from "../store";
import type { Popover } from "../store";

// Composer chips and their popovers: model (grouped by connected provider,
// searchable), reasoning-effort variant, and agent (turn runner). Each
// popover opens above its own chip, left-aligned to it, and only one popover
// is ever open (the shared `popover` signal, which also closes the ring's
// breakdown). Keyboard: ↑↓ move, Enter picks, Esc closes — a capture-phase
// window listener, so the composer's own handler never sees the keystroke.

interface Entry {
  key: string;
  label: string;
  hint?: string;
  badge?: string;
  active?: boolean;
}

interface Group {
  key: string;
  name: string;
  rows: Entry[];
}

// Arrows move, Enter confirms the active row, Esc closes. The cursor starts
// on the selected row (callers pass its index), not the top. The active
// index lives in a ref the handler updates synchronously, so a quick Enter
// after an arrow never confirms a stale row.
function useMenuKeys(
  count: number,
  onPick: (active: number) => void,
  onClose: () => void,
  initial = 0,
): number {
  const [active, setActive] = useState(initial);
  const cur = useRef(initial);
  // onPick/onClose are inline arrows at the call sites — new identity every
  // render. Held in a ref so the window listener subscribes once per count,
  // not once per render; each keystroke reads the latest pair.
  const latest = useRef({ onPick, onClose });
  latest.current = { onPick, onClose };
  useEffect(() => {
    const move = (to: number) => {
      cur.current = to;
      setActive(to);
    };
    const handler = (e: KeyboardEvent) => {
      const { onPick, onClose } = latest.current;
      // The open menu is modal (click-away backdrop), so nothing else can
      // hold focus that matters — the menu owns these keys outright.
      if (e.key === "ArrowDown") {
        e.preventDefault();
        e.stopPropagation();
        move(count > 0 ? (cur.current + 1) % count : 0);
      } else if (e.key === "ArrowUp") {
        e.preventDefault();
        e.stopPropagation();
        move(count > 0 ? (cur.current + count - 1) % count : 0);
      } else if (e.key === "Enter") {
        e.preventDefault();
        e.stopPropagation();
        onPick(Math.min(cur.current, count - 1));
      } else if (e.key === "Escape") {
        e.preventDefault();
        e.stopPropagation();
        onClose();
      }
    };
    window.addEventListener("keydown", handler, true);
    return () => window.removeEventListener("keydown", handler, true);
  }, [count]);
  return active;
}

function Row(props: {
  entry: Entry;
  highlighted: boolean;
  onPick: () => void;
}) {
  const e = props.entry;
  return (
    <button
      role="option"
      aria-selected={Boolean(e.active)}
      class={`menu-item${e.active ? " selected" : ""}${
        props.highlighted ? " active" : ""
      }`}
      onMouseDown={(ev) => {
        ev.preventDefault();
        props.onPick();
      }}
    >
      <span class="menu-texts">
        <span class="menu-label">
          {e.label}
          {e.badge && <span class="menu-badge">{e.badge}</span>}
        </span>
        {e.hint && <span class="menu-sub">{e.hint}</span>}
      </span>
      {e.active && (
        <span class="menu-check">
          <CheckIcon />
        </span>
      )}
    </button>
  );
}

// Variant + agent: a plain list, no search, no footer.
function Menu(props: {
  kind: Popover;
  entries: Entry[];
  onPick: (key: string) => boolean;
  onClose: () => void;
}) {
  const pick = (index: number) => {
    const e = props.entries[index];
    if (e && !props.onPick(e.key)) props.onClose();
  };
  const active = useMenuKeys(
    props.entries.length,
    pick,
    props.onClose,
    Math.max(0, props.entries.findIndex((e) => e.active)),
  );
  return (
    <div class={`menu pop pop-${props.kind}`} role="listbox">
      <div class="menu-list">
        {props.entries.map((e, i) => (
          <Row
            key={e.key}
            entry={e}
            highlighted={i === active}
            onPick={() => pick(i)}
          />
        ))}
      </div>
    </div>
  );
}

// Model: "Search models" field on top, then one muted header per connected
// provider with its models under it, and a Manage models footer that hands
// over to the native command.
function ModelMenu(props: {
  groups: Group[];
  onPick: (key: string) => boolean;
  onClose: () => void;
}) {
  const [query, setQuery] = useState("");
  const q = query.trim().toLowerCase();
  const groups = q
    ? props.groups
        .map((g) => ({
          ...g,
          rows: g.rows.filter((r) =>
            `${r.label} ${r.hint ?? ""} ${g.name}`.toLowerCase().includes(q),
          ),
        }))
        .filter((g) => g.rows.length > 0)
    : props.groups;
  const flat = groups.flatMap((g) => g.rows);
  const pick = (index: number) => {
    const e = flat[index];
    if (e && !props.onPick(e.key)) props.onClose();
  };
  const active = useMenuKeys(
    flat.length,
    pick,
    props.onClose,
    Math.max(0, flat.findIndex((e) => e.active)),
  );
  let index = -1;
  return (
    <div class="menu pop pop-model" role="listbox">
      <div class="menu-search">
        <SearchIcon />
        <input
          placeholder="Search models"
          value={query}
          spellcheck={false}
          onInput={(e) => setQuery((e.target as HTMLInputElement).value)}
          ref={(el) => el?.focus()}
        />
      </div>
      <div class="menu-list">
        {groups.map((g) => (
          <div key={g.key} role="group" aria-label={g.name}>
            <div class="menu-group">{g.name}</div>
            {g.rows.map((e) => {
              index += 1;
              // Capture this row's position — a closure over `index` itself
              // would pick the last row no matter what was clicked.
              const at = index;
              return (
                <Row
                  key={e.key}
                  entry={e}
                  highlighted={at === active}
                  onPick={() => pick(at)}
                />
              );
            })}
          </div>
        ))}
        {flat.length === 0 && (
          <div class="menu-empty">
            {query ? "No matching models" : "No models available"}
          </div>
        )}
      </div>
      <button
        class="menu-footer"
        onMouseDown={(e) => {
          e.preventDefault();
          props.onClose();
          postToHost({ type: "manage-models" });
        }}
      >
        <SlidersIcon />
        <span>Manage models</span>
      </button>
    </div>
  );
}

// Chip + popover with a click-away backdrop. The chip renders its own label;
// nothing portals — the popover anchors to the chip (`.picker`), which is its
// nearest positioned ancestor.
function Chip(props: {
  title: string;
  kind: Popover;
  entries?: Entry[];
  groups?: Group[];
  onPick: (key: string) => boolean;
  children?: preact.ComponentChildren;
}) {
  const open = popover.value === props.kind;
  const close = () => setPopover(undefined);
  return (
    <div class="picker">
      {open && <div class="backdrop" onClick={close} />}
      <button
        class="comp-chip"
        title={props.title}
        aria-expanded={open}
        onClick={() => setPopover(open ? undefined : props.kind)}
      >
        {props.children}
        <span class="comp-chevron">
          <ChevronIcon />
        </span>
      </button>
      {open &&
        (props.groups ? (
          <ModelMenu groups={props.groups} onPick={props.onPick} onClose={close} />
        ) : (
          <Menu
            kind={props.kind}
            entries={props.entries ?? []}
            onPick={props.onPick}
            onClose={close}
          />
        ))}
    </div>
  );
}

const visibleAgents = (list: Agent[]): Agent[] =>
  list.filter((a) => a.mode === "primary" && !a.hidden);

const cap = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);

export function AgentPicker(props: { id?: string }) {
  const sel = currentSelection(props.id);
  // Sub-agent sessions run subagent-mode agents (their name can even look
  // like a model id). The send path keeps that truth; the chip only shows
  // agents the picker can actually list, else the default primary.
  const listed = visibleAgents(agents.value).some((a) => a.name === sel.agent);
  const shown = listed ? sel.agent : defaultAgent();
  return (
    <Chip
      title="Agent"
      kind="agent"
      entries={visibleAgents(agents.value).map((a) => ({
        key: a.name,
        label: cap(a.label ?? a.name),
        hint: a.description,
        active: a.name === shown,
      }))}
      onPick={(name) => {
        void setSelection(props.id, { agent: name });
        return false;
      }}
    >
      <span class="comp-chip-label">
        {cap(
          visibleAgents(agents.value).find((a) => a.name === shown)
            ?.label ?? shown,
        )}
      </span>
    </Chip>
  );
}

export function VariantPicker(props: { id?: string }) {
  const sel = currentSelection(props.id);
  const variants = modelVariants(sel.model);
  if (!sel.model || variants.length === 0) return null;
  // Sessions switched elsewhere can come back with the effort stored as the
  // literal "default". That is this picker's no-variant state — fold it in,
  // or no row shows selected — unless the model itself declares a "default"
  // variant, which then stays its own row.
  const cur = sel.model.variant?.toLowerCase();
  const declared = variants.find((v) => v.toLowerCase() === "default");
  return (
    <Chip
      title="Reasoning effort"
      kind="variant"
      entries={[
        {
          key: "",
          label: "Default",
          active: !cur || (!declared && cur === "default"),
        },
        ...variants.map((v) => ({
          key: v,
          label: cap(v),
          active: cur === v.toLowerCase(),
        })),
      ]}
      onPick={(v) => {
        void setSelection(props.id, {
          model: { ...sel.model!, variant: v || undefined },
        });
        return false;
      }}
    >
      <span class="comp-chip-label">
        {sel.model.variant ? cap(sel.model.variant) : "Default"}
      </span>
    </Chip>
  );
}

export function ModelPicker(props: { id?: string }) {
  const sel = currentSelection(props.id);
  const connected = providers.value?.connected ?? [];
  const all = providers.value?.all ?? [];
  const hidden = new Set(hiddenModels.value);

  // One group per connected provider; a row is the model's short name, the
  // reasoning variants it offers as the gray sub-label, and a "Free" badge
  // when the catalog marks it free. Hidden rows (Manage models) drop out,
  // and a provider whose rows are all hidden goes with them.
  const groups: Group[] = connected
    .map((pid) => {
      const p = all.find((x) => x.id === pid);
      return {
        key: pid,
        name: p?.name ?? pid,
        rows: Object.entries(p?.models ?? {})
          .filter(([mid]) => !hidden.has(`${pid}/${mid}`))
          .map(([mid, m]) => {
            const model: ModelSelection = { providerID: pid, id: mid };
            const variants = m.variants ? Object.keys(m.variants) : [];
            return {
              key: `${pid}/${mid}`,
              label: m.name ?? modelLabel(model),
              hint: variants.length ? variants.map(cap).join(" · ") : undefined,
              badge: modelFree(model) ? "Free" : undefined,
              active: sel.model?.providerID === pid && sel.model?.id === mid,
            };
          }),
      };
    })
    .filter((g) => g.rows.length > 0);

  // Entry keys are `${providerID}/${modelID}`; provider ids never carry a
  // slash, so the FIRST one separates the pair. Splitting at the last one
  // made a pathed model id ("accounts/fireworks/models/glm-5p3-flash")
  // dissolve into the providerID and every prompt fail
  // ProviderModelNotFoundError.
  const onPick = (key: string) => {
    const cut = key.indexOf("/");
    const providerID = key.slice(0, cut);
    const id = key.slice(cut + 1);
    if (!providerID || !id) return false;
    // Carry the reasoning-effort choice over only when the new model
    // actually offers it (a session row's variant can be a value like
    // "default" the target model never declared).
    const target = all.find((x) => x.id === providerID)?.models?.[id];
    const variants = target?.variants ? Object.keys(target.variants) : [];
    const variant = sel.model?.variant;
    void setSelection(props.id, {
      model: {
        providerID,
        id,
        ...(variant && variants.includes(variant) ? { variant } : {}),
      },
    });
    return false;
  };

  // Display identity, not send identity — see displayModel. The tile and
  // label follow the connected twin so the chip keeps its color across the
  // first pick.
  const shown = displayModel(sel.model);

  return (
    <Chip title="Model" kind="model" groups={groups} onPick={onPick}>
      <span
        class="tile comp-tile"
        style={{
          background: tileFor(shown?.providerID ?? "?").color,
        }}
      >
        {tileFor(shown?.providerID ?? "?").letter}
      </span>
      <span class="comp-chip-label">
        {shown ? modelLabel(shown) : "Model"}
      </span>
    </Chip>
  );
}
