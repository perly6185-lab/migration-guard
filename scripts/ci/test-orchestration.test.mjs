import test from "node:test";
import assert from "node:assert/strict";
import {
  planTestShards,
  resolveTestExecutionOptions
} from "./test-orchestration.mjs";

test("test orchestration limits unit concurrency and serializes integration files", () => {
  const options = resolveTestExecutionOptions({
    MG_TEST_UNIT_SHARD_SIZE: "2",
    MG_TEST_INTEGRATION_SHARD_SIZE: "2",
    MG_TEST_CONCURRENCY: "8"
  });
  const files = [
    "a.test.js",
    "b.test.js",
    "c.test.js",
    "integration-a.test.js",
    "integration-b.test.js",
    "integration-c.test.js"
  ];
  const shards = planTestShards(
    files,
    (file) => file.startsWith("integration-") ? "integration" : "unit",
    options
  );
  assert.deepEqual(shards.map(({ id, layer, files: shardFiles, concurrency }) => ({
    id,
    layer,
    files: shardFiles,
    concurrency
  })), [
    {
      id: "unit-1",
      layer: "unit",
      files: ["a.test.js", "c.test.js"],
      concurrency: 2
    },
    {
      id: "unit-2",
      layer: "unit",
      files: ["b.test.js"],
      concurrency: 1
    },
    {
      id: "integration-1",
      layer: "integration",
      files: ["integration-a.test.js", "integration-c.test.js"],
      concurrency: 1
    },
    {
      id: "integration-2",
      layer: "integration",
      files: ["integration-b.test.js"],
      concurrency: 1
    }
  ]);
});

test("test orchestration rejects unsafe timeout and concurrency values", () => {
  assert.throws(
    () => resolveTestExecutionOptions({ MG_TEST_CONCURRENCY: "0" }),
    /MG_TEST_CONCURRENCY must be a positive integer/
  );
  assert.throws(
    () => resolveTestExecutionOptions({ MG_TEST_FILE_TIMEOUT_MS: "1.5" }),
    /MG_TEST_FILE_TIMEOUT_MS must be a positive integer/
  );
});
