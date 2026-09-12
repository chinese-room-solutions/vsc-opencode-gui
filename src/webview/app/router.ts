import { computed, signal } from "@preact/signals";
import { postToHost } from "./host";

export type Route =
  | { view: "home" }
  // `child` views a sub-agent session inside its parent's tab (the official
  // app's sub-session drill-down): the tab still belongs to `id`, the child
  // renders under a parent/child breadcrumb.
  | { view: "session"; id: string; child?: string }
  | { view: "draft" };

export const route = signal<Route>({ view: "home" });

// Sessions this app instance has open, in bar order. The list is reported
// to the host, so a restart brings the whole set back — not just the
// visible route.
export const openTabs = signal<string[]>([]);

// The tab on screen — derived from `route` (undefined on home/draft).
export const activeTab = computed<string | undefined>(() => {
  const r = route.value;
  return r.view === "session" ? r.id : undefined;
});

// Session tabs whose turn ended while another view was on screen: a green
// pixel on the tab until the user opens it. Ephemeral by design — a webview
// reload forgets it, like any "seen" state.
export const unreadTabs = signal<ReadonlySet<string>>(new Set());

// The host stores the route and tab list (workspaceState) so the next
// webview load restores them — no re-render on its side.
function persist(): void {
  postToHost({ type: "route-changed", route: route.value, tabs: openTabs.value });
}

// The last session tab that was on screen, so Home toggles: first press
// goes home, second returns to it. Session-scope only — a reload while on
// home has nothing to toggle back to.
let lastTab: string | undefined;

// The toolbar Home button. From a session (or draft): home. From home: back
// to the previous tab, when it's still open.
export function goHome(): void {
  if (route.value.view !== "home") {
    navigate({ view: "home" });
    return;
  }
  if (lastTab && openTabs.value.includes(lastTab)) {
    navigate({ view: "session", id: lastTab });
  }
}

export function navigate(next: Route): void {
  route.value = next;
  if (next.view === "session") {
    lastTab = next.id;
    if (!openTabs.value.includes(next.id)) {
      openTabs.value = [...openTabs.value, next.id];
    }
    if (unreadTabs.value.has(next.id))
      unreadTabs.value = new Set(
        [...unreadTabs.value].filter((t) => t !== next.id),
      );
  }
  persist();
}

// Close a tab (middle-click). Closing the visible one goes home; the other
// tabs stay open.
export function closeTab(id: string): void {
  openTabs.value = openTabs.value.filter((t) => t !== id);
  if (unreadTabs.value.has(id))
    unreadTabs.value = new Set(
      [...unreadTabs.value].filter((t) => t !== id),
    );
  if (activeTab.value === id) navigate({ view: "home" });
  else persist();
}

// Drag-reorder: move a tab to the index it should occupy in the final
// list. The index is pre-adjusted by the caller for the removal of the
// dragged tab, so it drops exactly where it was aimed.
export function moveTab(id: string, to: number): void {
  const from = openTabs.value.indexOf(id);
  if (from < 0) return;
  const tabs = openTabs.value.slice();
  tabs.splice(from, 1);
  tabs.splice(Math.max(0, Math.min(tabs.length, to)), 0, id);
  openTabs.value = tabs;
  persist();
}

// Boot restore from the opencode-route/opencode-tabs metas AppHost baked
// into the page. The tab list seeds the bar before the route navigates, so
// the active session keeps its stored position instead of jumping last.
// Unknown/malformed routes degrade to home; a stale session id is tolerated
// until the first sessions fetch (the store bounces then — pagination means
// the list can't judge before it has loaded).
export function restoreRoute(): void {
  const tabsRaw =
    document
      .querySelector('meta[name="opencode-tabs"]')
      ?.getAttribute("content") ?? "";
  try {
    const tabs = JSON.parse(tabsRaw) as unknown;
    if (Array.isArray(tabs)) {
      openTabs.value = tabs.filter((t): t is string => typeof t === "string");
    }
  } catch {
    // Malformed meta — start with an empty bar.
  }
  const raw =
    document
      .querySelector('meta[name="opencode-route"]')
      ?.getAttribute("content") ?? "";
  if (!raw) return;
  try {
    const r = JSON.parse(raw) as Route;
    if (r.view === "session" && r.id) {
      navigate({
        view: "session",
        id: r.id,
        ...(r.child ? { child: r.child } : {}),
      });
    } else if (r.view === "draft") navigate({ view: "draft" });
  } catch {
    // Malformed meta — start at home.
  }
}
