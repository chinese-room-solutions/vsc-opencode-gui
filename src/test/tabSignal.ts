import * as assert from "assert";
import * as vscode from "vscode";
import { TabSignal } from "../webview/TabSignal";

// Runs inside the extension host (see lifecycle.ts for the harness). Covers
// the tab icon state machine's reset: when a page navigates to a loading or
// error view it stops posting tab-signal facts, so the host-side flags must
// drop and the icon return to idle.

suite("opencode tab signal", function () {
  test("apply busy sets the spinner, reset returns to idle", function () {
    const icons: string[] = [];
    const sig = new TabSignal<string>(
      { frame: (state) => state, idle: "idle" },
      (icon) => icons.push(icon),
    );
    sig.apply({ busy: true }, false);
    assert.strictEqual(icons.at(-1), "busy", "busy shows the spinner");
    sig.apply({ attention: true }, false);
    assert.strictEqual(icons.at(-1), "attention", "an ask outranks busy");
    sig.apply({ attention: false, busy: false, turnEnded: true }, false);
    assert.strictEqual(icons.at(-1), "ready", "the green mark latches");
    sig.reset();
    assert.strictEqual(icons.at(-1), "idle", "reset clears every flag");
    assert.strictEqual(icons.length, 4, "one set per state change");
    sig.reset();
    assert.strictEqual(icons.length, 4, "already idle, reset sets nothing");
  });

  test("setError and setLoading fire onResetTabSignal", async function () {
    // The host half: re-navigating the page to a loading/error view kills
    // the poster, so the host must reset the icon itself.
    const { AppHost } = await import("../webview/AppHost");
    const extUri = vscode.extensions.getExtension(
      "chinese-room-solutions.vsc-opencode-gui",
    )!.extensionUri;
    const resets: number[] = [];
    const host = new AppHost({
      extensionUri: extUri,
      kind: "session",
      sessionId: "ses-signal-reset",
      routeStore: { get: () => undefined, set: () => {} } as never,
      tabsStore: { get: () => [] } as never,
      projectStore: {
        list: () => [],
        tombstoned: () => false,
        tombstone: () => {},
      } as never,
      openProject: () => Promise.resolve(),
      hiddenModels: { get: () => [] },
      hiddenProviders: { get: () => [] },
      providerColors: { get: () => ({}) },
      onResetTabSignal: () => resets.push(1),
    });
    try {
      host.setError("boom");
      host.setLoading();
      assert.strictEqual(resets.length, 2, "both views reset the icon");
    } finally {
      host.dispose();
    }
  });
});
