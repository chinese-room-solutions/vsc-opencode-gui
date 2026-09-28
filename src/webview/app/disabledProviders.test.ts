import { strict as assert } from "node:assert";
import {
  readDisabledProviders,
  setDisabledProvidersInText,
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
