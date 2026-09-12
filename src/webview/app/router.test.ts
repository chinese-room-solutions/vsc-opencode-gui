import "./setup.test";
import { strict as assert } from "node:assert";
import { metas, hostPosted } from "./setup.test";
import {
  activeTab,
  closeTab,
  goHome,
  moveTab,
  navigate,
  openTabs,
  restoreRoute,
  route,
  unreadTabs,
} from "./router";

describe("router", () => {
  afterEach(() => {
    metas.delete("opencode-tabs");
    metas.delete("opencode-route");
  });

  it("opens tabs on session navigation and clears unread", () => {
    unreadTabs.value = new Set(["s1"]);
    navigate({ view: "session", id: "s1" });
    assert.equal(activeTab.value, "s1");
    assert.deepEqual(openTabs.value, ["s1"]);
    assert.equal(unreadTabs.value.has("s1"), false);
    assert.deepEqual(hostPosted.at(-1), {
      type: "route-changed",
      route: { view: "session", id: "s1" },
      tabs: ["s1"],
    });
  });
  it("keeps tab order on revisit", () => {
    navigate({ view: "session", id: "s1" });
    navigate({ view: "session", id: "s2" });
    navigate({ view: "session", id: "s1" });
    assert.deepEqual(openTabs.value, ["s1", "s2"]);
    assert.equal(activeTab.value, "s1");
  });
  it("home clears the active tab but keeps tabs open", () => {
    navigate({ view: "session", id: "s1" });
    navigate({ view: "home" });
    assert.equal(activeTab.value, undefined);
    assert.deepEqual(openTabs.value, ["s1"]);
    assert.deepEqual(route.value, { view: "home" });
  });
  it("goHome toggles back to the last open tab", () => {
    navigate({ view: "session", id: "s1" });
    goHome();
    assert.deepEqual(route.value, { view: "home" });
    goHome();
    assert.deepEqual(route.value, { view: "session", id: "s1" });
  });
  it("closing a background tab keeps the route", () => {
    navigate({ view: "session", id: "s1" });
    navigate({ view: "session", id: "s2" });
    closeTab("s1");
    assert.deepEqual(openTabs.value, ["s2"]);
    assert.equal(activeTab.value, "s2");
  });
  it("closing the visible tab goes home and drops unread", () => {
    navigate({ view: "session", id: "s1" });
    unreadTabs.value = new Set(["s1"]);
    closeTab("s1");
    assert.deepEqual(openTabs.value, []);
    assert.deepEqual(route.value, { view: "home" });
    assert.equal(unreadTabs.value.has("s1"), false);
  });
  it("moveTab reorders, clamped", () => {
    navigate({ view: "session", id: "s1" });
    navigate({ view: "session", id: "s2" });
    navigate({ view: "session", id: "s3" });
    moveTab("s3", 0);
    assert.deepEqual(openTabs.value, ["s3", "s1", "s2"]);
    moveTab("s3", 99);
    assert.deepEqual(openTabs.value, ["s1", "s2", "s3"]);
    moveTab("nonsense", 0);
    assert.deepEqual(openTabs.value, ["s1", "s2", "s3"]);
  });
  it("restores tabs and a session route (with child) from metas", () => {
    metas.set(
      "opencode-tabs",
      JSON.stringify(["s1", "s2", 42, "s3"]),
    );
    metas.set(
      "opencode-route",
      JSON.stringify({ view: "session", id: "s2", child: "sub9" }),
    );
    restoreRoute();
    assert.deepEqual(openTabs.value, ["s1", "s2", "s3"]);
    assert.deepEqual(route.value, {
      view: "session",
      id: "s2",
      child: "sub9",
    });
    assert.equal(activeTab.value, "s2");
  });
  it("restores a draft route", () => {
    metas.set("opencode-route", JSON.stringify({ view: "draft" }));
    restoreRoute();
    assert.deepEqual(route.value, { view: "draft" });
    assert.equal(activeTab.value, undefined);
  });
  it("degrades malformed metas to home", () => {
    metas.set("opencode-tabs", "{not json");
    metas.set("opencode-route", "{not json");
    restoreRoute();
    assert.deepEqual(openTabs.value, []);
    assert.deepEqual(route.value, { view: "home" });
  });
  it("ignores a route meta without a session id", () => {
    metas.set("opencode-route", JSON.stringify({ view: "session" }));
    restoreRoute();
    assert.deepEqual(route.value, { view: "home" });
  });
});
