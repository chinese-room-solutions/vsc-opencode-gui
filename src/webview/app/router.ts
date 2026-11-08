import { signal } from "@preact/signals";
import { hostKind, postToHost } from "./host";

export type Route =
  | { view: "home" }
  // `child` views a sub-agent session inside its parent's panel (the
  // official app's sub-session drill-down): the panel still belongs to
  // `id`, the child renders under a parent/child breadcrumb.
  | { view: "session"; id: string; child?: string };

export const route = signal<Route>({ view: "home" });

// The host stores the last-active route (workspaceState) so the next
// webview load restores it — no re-render on its side. Only session
// panels persist: the navigator owns no route, and a "home" written from
// it would clobber the last-active session the panels record.
function persist(): void {
  if (hostKind.value === "navigator") return;
  postToHost({ type: "route-changed", route: route.value });
}

export function navigate(next: Route): void {
  route.value = next;
  persist();
}

// Boot restore from the opencode-route meta AppHost baked into the page.
// A session panel opens straight into its session, child drill-down
// included; the navigator ignores the meta — it renders its own lists.
// Unknown/malformed routes degrade to home (the panel's not-found card);
// a stale session id is tolerated until the first sessions fetch (the
// store bounces then — pagination means the list can't judge before it
// has loaded).
export function restoreRoute(): void {
  if (hostKind.value === "navigator") return;
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
    }
  } catch {
    // Malformed meta — stay home.
  }
}
