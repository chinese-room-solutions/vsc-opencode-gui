import "./setup.test";
import { strict as assert } from "node:assert";
import { metas, hostPosted } from "./setup.test";
import { hostKind } from "./host";
import { escapeChildRoute, navigate, restoreRoute, route } from "./router";

describe("router", () => {
  afterEach(() => {
    metas.delete("opencode-route");
    hostKind.value = "session";
  });

  it("navigate records the route for the host", () => {
    navigate({ view: "session", id: "s1" });
    assert.deepEqual(route.value, { view: "session", id: "s1" });
    assert.deepEqual(hostPosted.at(-1), {
      type: "route-changed",
      route: { view: "session", id: "s1" },
    });
  });
  it("restores a session route (with child) from the meta", () => {
    metas.set(
      "opencode-route",
      JSON.stringify({ view: "session", id: "s2", child: "sub9" }),
    );
    restoreRoute();
    assert.deepEqual(route.value, {
      view: "session",
      id: "s2",
      child: "sub9",
    });
  });
  it("escapeChildRoute leaves a child drill-down for its parent", () => {
    navigate({ view: "session", id: "s5", child: "sub1" });
    hostPosted.length = 0;
    assert.equal(escapeChildRoute(), true);
    assert.deepEqual(route.value, { view: "session", id: "s5" });
    assert.deepEqual(hostPosted.at(-1), {
      type: "route-changed",
      route: { view: "session", id: "s5" },
    });
  });
  it("escapeChildRoute is a no-op outside a child drill-down", () => {
    navigate({ view: "session", id: "s6" });
    assert.equal(escapeChildRoute(), false);
    assert.deepEqual(route.value, { view: "session", id: "s6" });
    navigate({ view: "home" });
    assert.equal(escapeChildRoute(), false);
    assert.deepEqual(route.value, { view: "home" });
  });
  it("degrades a malformed meta to home", () => {
    metas.set("opencode-route", "{not json");
    restoreRoute();
    assert.deepEqual(route.value, { view: "home" });
  });
  it("ignores a route meta without a session id", () => {
    metas.set("opencode-route", JSON.stringify({ view: "session" }));
    restoreRoute();
    assert.deepEqual(route.value, { view: "home" });
  });
  it("the navigator host ignores the meta and never persists", () => {
    hostKind.value = "navigator";
    metas.set(
      "opencode-route",
      JSON.stringify({ view: "session", id: "s3" }),
    );
    hostPosted.length = 0;
    restoreRoute();
    assert.deepEqual(route.value, { view: "home" });
    // The sidebar can never clobber the last-active route the session
    // panels write — even a stray navigate stays silent.
    navigate({ view: "session", id: "s4" });
    assert.deepEqual(hostPosted, []);
  });
});
