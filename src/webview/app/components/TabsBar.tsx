import { useState } from "preact/hooks";
import { CloseIcon, GridIcon, PixelMark, PixelSpinner, PlusIcon } from "../icons";
import { RenameInput } from "./RenameInput";
import { activeTab, goHome, moveTab, navigate, openTabs, unreadTabs } from "../router";
import {
  closeSessionTab,
  deleteSession,
  formatSessionTimes,
  newSession,
  pendingPermissions,
  pendingQuestions,
  renameSession,
  sessionStatus,
  sessionTile,
  sessionTitle,
  sessions,
} from "../store";
import { useArm } from "../useArm";

// Toolbar above the content panel, every route: home button, then the open
// session tabs (divider only while tabs exist) and a bare "+" that makes a
// real session on the click. Tabs are a letter tile + gray title + close
// button; the active one adds a filled pill. Middle-click closes a tab
// (view-level only); double-click or right-click starts a rename, and the
// right-click menu offers rename/delete — both act on the session itself.
// Tabs drag to reorder: the list re-orders live under the drag, and the
// new order persists with everything else.
export function TabsBar() {
  const tabs = openTabs.value;
  // Tabs to paint yellow: every pending ask (permission or question) is
  // attributed to the tab owning its session — the root of the asking
  // session's parent chain, so a locked sub-agent thread marks the parent's
  // tab, and a locked root marks its own.
  const lockedRoots = new Set<string>();
  for (const a of [...pendingPermissions.value, ...pendingQuestions.value]) {
    // Walk up the parent chain; a malformed cycle must not spin forever.
    let sid: string | undefined = a.sessionID;
    const seen = new Set<string>();
    while (sid !== undefined && !seen.has(sid)) {
      seen.add(sid);
      const row = sessions.value.find((s) => s.id === sid);
      if (!row) break;
      if (!row.parentID) {
        lockedRoots.add(row.id);
        break;
      }
      sid = row.parentID;
    }
  }
  const [menu, setMenu] = useState<{ id: string; x: number; y: number }>();
  const [renaming, setRenaming] = useState<string>();
  const [armed, arm, disarm] = useArm();
  const [dragging, setDragging] = useState<string>();

  const closeMenu = () => {
    setMenu(undefined);
    disarm();
  };

  const menuDelete = (id: string) => {
    if (!armed) {
      arm();
      return;
    }
    // deleteSession closes the session's tab too (a closed active tab goes
    // home), so the bar needs no extra bookkeeping.
    disarm();
    setMenu(undefined);
    void deleteSession(id);
  };

  return (
    <div class="toolbar">
      <button
        class="tb-home"
        title="Home"
        aria-label="Home"
        onClick={goHome}
      >
        <GridIcon />
      </button>
      {tabs.length > 0 && (
        <>
          <div class="tb-sep" />
          <div class="tb-tabs" role="tablist">
            {tabs.map((id) => {
              const row = sessions.value.find((s) => s.id === id);
              // A restored tab waits out the boot sessions fetch with a
              // skeleton — the fallback would flash the raw ses_* id under a
              // hash-colored tile. Tabs whose session is really gone are
              // pruned by validateRestored right after.
              const known = row !== undefined;
              const title = known ? sessionTitle(row, id) : "";
              const active = activeTab.value === id;
              const tile = known ? sessionTile(row, id) : undefined;
              return (
                <div
                  key={id}
                  class={[
                    "tab",
                    active && "active",
                    dragging === id && "dragging",
                    !known && "pending",
                  ]
                    .filter(Boolean)
                    .join(" ")}
                  role="tab"
                  aria-selected={active}
                  tabindex={0}
                  // The label already says the title; the hover adds both
                  // moments.
                  title={row ? formatSessionTimes(row) : undefined}
                  // Drag disabled while renaming: the input needs its mouse.
                  draggable={renaming !== id}
                  onDragStart={(e) => {
                    setDragging(id);
                    const dt = e.dataTransfer;
                    if (!dt) return;
                    dt.effectAllowed = "move";
                    dt.setData("text/plain", id);
                  }}
                  onDragOver={(e) => {
                    if (!dragging || dragging === id) return;
                    const dt = e.dataTransfer;
                    if (!dt) return;
                    e.preventDefault();
                    dt.dropEffect = "move";
                    // Drop on the hovered tab's near or far half. moveTab
                    // indexes the post-removal list, so shift the hovered
                    // slot for the dragged tab leaving its own.
                    const list = openTabs.value;
                    const from = list.indexOf(dragging);
                    const i = list.indexOf(id);
                    if (from < 0 || i < 0) return;
                    const hovered = i > from ? i - 1 : i;
                    const rect = e.currentTarget.getBoundingClientRect();
                    const to =
                      e.clientX > rect.left + rect.width / 2
                        ? hovered + 1
                        : hovered;
                    // to === from puts the dragged tab back in its own
                    // slot — reordering there would just flicker.
                    if (to !== from) moveTab(dragging, to);
                  }}
                  onDrop={(e) => e.preventDefault()}
                  onDragEnd={() => setDragging(undefined)}
                  onClick={() => navigate({ view: "session", id })}
                  onKeyDown={(e) => {
                    if (e.key === "Enter" || e.key === " ") {
                      e.preventDefault();
                      navigate({ view: "session", id });
                    }
                  }}
                  onAuxClick={(e) => {
                    if (e.button === 1) {
                      e.preventDefault();
                      closeSessionTab(id);
                    }
                  }}
                  onDblClick={(e) => {
                    e.preventDefault();
                    setRenaming(id);
                  }}
                  onContextMenu={(e) => {
                    e.preventDefault();
                    disarm();
                    setMenu({ id, x: e.clientX, y: e.clientY });
                  }}
                >
                  {lockedRoots.has(id) ? (
                    // Yellow beats the busy spinner: an ask needs the user,
                    // not patience. The mark pulses for peripheral vision
                    // (styles.css). Green: a turn ended while this tab
                    // wasn't on screen (store marks it in setIdle).
                    <PixelMark tone="attention" />
                  ) : sessionStatus.value[id]?.type === "busy" ? (
                    // opencode's pixel spinner stands in for the tile while
                    // the session works.
                    <PixelSpinner />
                  ) : unreadTabs.value.has(id) ? (
                    <PixelMark tone="ready" />
                  ) : (
                    <span
                      class="tile"
                      style={tile ? { background: tile.color } : undefined}
                    >
                      {tile ? tile.letter : ""}
                    </span>
                  )}
                  {renaming === id ? (
                    <RenameInput
                      class="rename-input tab-rename"
                      title={title}
                      onCommit={(t) => void renameSession(id, t)}
                      onCancel={() => setRenaming(undefined)}
                    />
                  ) : (
                    <span class="tab-title">{title}</span>
                  )}
                  <button
                    class="tab-close"
                    title="Close tab"
                    aria-label="Close tab"
                    onClick={(e) => {
                      e.stopPropagation();
                      closeSessionTab(id);
                    }}
                    onDblClick={(e) => e.stopPropagation()}
                  >
                    <CloseIcon />
                  </button>
                </div>
              );
            })}
          </div>
        </>
      )}
      <button
        class="tb-plus"
        title="New session"
        aria-label="New session"
        onClick={() => void newSession()}
      >
        <PlusIcon />
      </button>
      {menu && (
        <>
          <div class="backdrop" onClick={closeMenu} />
          <div class="tabmenu" style={{ left: menu.x, top: menu.y }}>
            <button
              class="menu-item"
              onClick={() => {
                // The raw id (ses_…): what peer routing and the API want.
                void navigator.clipboard.writeText(menu.id).catch(() => {});
                closeMenu();
              }}
            >
              <span class="menu-label">Copy Session ID</span>
            </button>
            <button
              class="menu-item"
              onClick={() => {
                setRenaming(menu.id);
                closeMenu();
              }}
            >
              <span class="menu-label">Rename</span>
            </button>
            <button
              class={armed ? "menu-item armed" : "menu-item"}
              onClick={() => menuDelete(menu.id)}
            >
              <span class="menu-label">
                {armed ? "Confirm Deletion" : "Delete"}
              </span>
            </button>
          </div>
        </>
      )}
    </div>
  );
}
