import "./setup.test";
import { strict as assert } from "node:assert";
import { baseName, parentName, tileFor } from "./tile";

describe("tile", () => {
  it("splits display names on both separators", () => {
    assert.equal(baseName("C:\\w\\repo\\client.go"), "client.go");
    assert.equal(baseName("/w/repo/app"), "app");
    assert.equal(baseName("solo"), "solo");
    assert.equal(baseName("/"), "/");
  });
  it("names the parent folder as disambiguator", () => {
    assert.equal(parentName("C:\\a\\repo\\client.go"), "repo");
    assert.equal(parentName("/w/repo/app"), "repo");
    assert.equal(parentName("app"), "app");
  });
  it("maps host palette names to their hex", () => {
    assert.equal(tileFor("anything", "orange").color, "#e8590c");
    assert.equal(tileFor("anything", "pink").color, "#d6336c");
    assert.equal(tileFor("anything", "gray").color, "#868e96");
  });
  it("hashes unknown palettes and bare keys into the same set", () => {
    const colors = new Set([
      "#e8590c",
      "#f08c00",
      "#0c8599",
      "#2f9e44",
      "#e03131",
      "#d6336c",
      "#1971c2",
      "#9c36b5",
      "#868e96",
    ]);
    const t = tileFor("C:\\work\\repo");
    assert.ok(colors.has(t.color));
    assert.equal(tileFor("C:\\WORK\\REPO").color, t.color);
    assert.equal(tileFor("x", "no-such-color").color, tileFor("x").color);
  });
  it("letters from the basename, uppercased, ? when empty", () => {
    assert.equal(tileFor("C:\\w\\repo").letter, "R");
    assert.equal(tileFor("").letter, "?");
  });
  it("is stable for the same key", () => {
    assert.deepEqual(tileFor("stable-key"), tileFor("stable-key"));
  });
});
