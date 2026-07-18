import assert from "node:assert/strict";
import test from "node:test";
import { CLI_COMMAND_NAMES, validateCliCommandRegistry } from "./cliRegistry.js";

test("CLI command catalog remains complete and unique", () => {
  assert.equal(new Set(CLI_COMMAND_NAMES).size, CLI_COMMAND_NAMES.length);
  assert.deepEqual(CLI_COMMAND_NAMES.slice(0, 3), ["help", "--help", "-h"]);
  assert.ok(CLI_COMMAND_NAMES.includes("issue-control"));
  assert.ok(CLI_COMMAND_NAMES.includes("proposal"));
});

test("CLI registry validation detects missing and unexpected commands", () => {
  const complete = Object.fromEntries(CLI_COMMAND_NAMES.map((command) => [command, () => undefined]));
  assert.doesNotThrow(() => validateCliCommandRegistry(complete));
  const { policy: _removed, ...missing } = complete;
  assert.throws(() => validateCliCommandRegistry(missing), /missing: policy/);
  assert.throws(() => validateCliCommandRegistry({ ...complete, surprise: () => undefined }), /unexpected: surprise/);
});
