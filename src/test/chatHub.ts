import * as assert from "assert";
import { ChatHub } from "../webview/ChatHub";
import type { AppHost } from "../webview/AppHost";
import type { Dialect } from "../server/dialect";

// Host-side fan-out isolation: a chat whose webview died (hidden view,
// disposed without the hub hearing about it) throws on every push, and
// one throw must not abort a broadcast — the surviving pages still get
// the state, and callers like the Restart command (hub.setLoading before
// the old server's dispose) keep running.
suite("ChatHub fan-out isolation", function () {
  test("a throwing chat does not abort a broadcast", function () {
    const hub = new ChatHub();
    const mk = (sink: string[], throwing: { on: boolean }): AppHost =>
      ({
        setLoading: () => {
          sink.push("loading");
          if (throwing.on) throw new Error("webview disposed");
        },
        setServerUrl: (url: string) => {
          sink.push(url);
          if (throwing.on) throw new Error("webview disposed");
        },
        setPeers: () => {},
      }) as unknown as AppHost;
    const dead: string[] = [];
    const live: string[] = [];
    const deadThrowing = { on: false };
    hub.register(mk(dead, deadThrowing));
    hub.register(mk(live, { on: false }));
    // The dead page was healthy at register time — register itself
    // pushes the loading state — then started throwing afterwards.
    deadThrowing.on = true;
    hub.setLoading();
    hub.setServerUrl("http://localhost:1", "v1" as Dialect);
    // One "loading" from each register, one from the setLoading broadcast.
    assert.deepStrictEqual(
      live,
      ["loading", "loading", "http://localhost:1"],
      "the working chat received both broadcasts",
    );
    assert.deepStrictEqual(
      dead,
      ["loading", "loading", "http://localhost:1"],
      "the dead chat got the calls (and threw, caught)",
    );
    hub.dispose();
  });
});
