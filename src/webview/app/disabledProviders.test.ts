import { strict as assert } from "node:assert";
import {
  readDisabledProviders,
  readEnabledProviders,
  setDisabledProvidersInText,
  setEnabledProvidersInText,
  stripJsonc,
} from "../../server/disabledProviders";

describe("disabled_providers config text layer", () => {
  it("strips line and block comments outside strings", () => {
    assert.equal(
      stripJsonc(
        `{"a": "x//y", // tail\n /* block "quoted" */ "b": 2, /* c */ }`,
      ),
      `{"a": "x//y", \n  "b": 2  }`,
    );
  });

  it("drops trailing commas and escapes inside strings survive", () => {
    assert.equal(
      stripJsonc(`{"a": "he said \\"hi\\"", "b": [1, 2,],}`),
      `{"a": "he said \\"hi\\"", "b": [1, 2]}`,
    );
  });

  it("reads the denylist from json and jsonc", () => {
    assert.deepEqual(
      readDisabledProviders(`{"disabled_providers": ["openai"]}`),
      ["openai"],
    );
    assert.deepEqual(
      readDisabledProviders(
        `{
          // gone while the gateway is down
          "disabled_providers": ["openai", "zai",
          ], "model": "zai/glm-5.3",
        }`,
      ),
      ["openai", "zai"],
    );
    assert.deepEqual(readDisabledProviders(`{}`), []);
    assert.deepEqual(readDisabledProviders(undefined), []);
    assert.deepEqual(readDisabledProviders(`{broken`), []);
  });

  it("replaces the existing array without touching the rest of the file", () => {
    const before = `{
  // keep me
  "model": "zai/glm-5.3", /* and me */
  "disabled_providers": [
    "openai"
  ]
}`;
    const after = setDisabledProvidersInText(before, ["openai", "zai"]);
    assert.deepEqual(readDisabledProviders(after), ["openai", "zai"]);
    assert.ok(after.includes("// keep me"));
    assert.ok(after.includes("/* and me */"));
    assert.ok(after.includes(`"model": "zai/glm-5.3"`));
  });

  it("inserts the key into an empty or keyless file", () => {
    assert.deepEqual(
      readDisabledProviders(setDisabledProvidersInText(``, ["openai"])),
      ["openai"],
    );
    assert.deepEqual(
      readDisabledProviders(setDisabledProvidersInText(`{}`, ["openai"])),
      ["openai"],
    );
    assert.deepEqual(
      readDisabledProviders(
        setDisabledProvidersInText(
          `{\n  "model": "zai/glm-5.3"\n}`,
          ["openai"],
        ),
      ),
      ["openai"],
    );
    // An emptying write keeps the key as an empty list (same semantics).
    assert.deepEqual(
      readDisabledProviders(
        setDisabledProvidersInText(
          `{"disabled_providers": ["openai"]}`,
          [],
        ),
      ),
      [],
    );
  });
});

describe("enabled_providers config text layer", () => {
  it("reads the allowlist, distinguishing absent from empty", () => {
    assert.equal(readEnabledProviders(`{}`), null);
    assert.equal(readEnabledProviders(undefined), null);
    assert.equal(
      readEnabledProviders(`{"disabled_providers": ["openai"]}`),
      null,
    );
    assert.equal(readEnabledProviders(`{broken`), null);
    assert.deepEqual(
      readEnabledProviders(`{"enabled_providers": []}`),
      [],
    );
    assert.deepEqual(
      readEnabledProviders(
        `{
          // only the coding plan may run
          "enabled_providers": ["zai-coding-plan",
          ], "model": "zai/glm-5.3",
        }`,
      ),
      ["zai-coding-plan"],
    );
  });

  it("replaces and inserts like the denylist writer", () => {
    const before = `{
  // keep me
  "model": "zai/glm-5.3",
  "enabled_providers": [
    "zai"
  ]
}`;
    const after = setEnabledProvidersInText(before, ["zai-coding-plan"]);
    assert.deepEqual(readEnabledProviders(after), ["zai-coding-plan"]);
    assert.ok(after.includes("// keep me"));
    assert.ok(after.includes(`"model": "zai/glm-5.3"`));
    assert.deepEqual(
      readEnabledProviders(setEnabledProvidersInText(``, ["zai"])),
      ["zai"],
    );
    assert.deepEqual(
      readEnabledProviders(setEnabledProvidersInText(`{}`, ["zai"])),
      ["zai"],
    );
  });

  it("null removes the key with its separating comma, wherever it sits", () => {
    const trailing = setEnabledProvidersInText(
      `{\n  "enabled_providers": ["zai"],\n  "model": "zai/glm-5.3"\n}`,
      null,
    );
    assert.equal(readEnabledProviders(trailing), null);
    assert.deepEqual(
      JSON.parse(stripJsonc(trailing)),
      { model: "zai/glm-5.3" },
    );
    const leading = setEnabledProvidersInText(
      `{\n  "model": "zai/glm-5.3",\n  "enabled_providers": ["zai"]\n}`,
      null,
    );
    assert.equal(readEnabledProviders(leading), null);
    assert.deepEqual(
      JSON.parse(stripJsonc(leading)),
      { model: "zai/glm-5.3" },
    );
    const sole = setEnabledProvidersInText(
      `{\n  "enabled_providers": ["zai"]\n}`,
      null,
    );
    assert.deepEqual(JSON.parse(stripJsonc(sole)), {});
    // Absent key: byte-identical no-op.
    const untouched = `{\n  "model": "zai/glm-5.3"\n}`;
    assert.equal(setEnabledProvidersInText(untouched, null), untouched);
  });
});
