import test from "node:test";
import assert from "node:assert/strict";
import { dispatchCliCommand, type CliCommandRequest } from "./cliDispatch.js";

test("CLI dispatch invokes exactly the registered command", async () => {
  const calls: string[] = [];
  const request: CliCommandRequest = { command: "scan", options: {}, positionals: [] };
  assert.equal(await dispatchCliCommand(request, {
    scan: async () => { calls.push("scan"); },
    verify: async () => { calls.push("verify"); }
  }), true);
  assert.deepEqual(calls, ["scan"]);
});

test("CLI dispatch reports unknown commands without side effects", async () => {
  assert.equal(await dispatchCliCommand({ command: "unknown", options: {}, positionals: [] }, {}), false);
});
