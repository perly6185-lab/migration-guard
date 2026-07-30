const DEFAULT_UNIT_SHARD_SIZE = 12;
const DEFAULT_INTEGRATION_SHARD_SIZE = 2;
const DEFAULT_UNIT_CONCURRENCY = 4;
const DEFAULT_TEST_TIMEOUT_MS = 300_000;
const DEFAULT_UNIT_SHARD_TIMEOUT_MS = 360_000;
const DEFAULT_INTEGRATION_SHARD_TIMEOUT_MS = 420_000;

export function resolveTestExecutionOptions(environment = process.env) {
  return {
    unitShardSize: positiveInteger(
      environment.MG_TEST_UNIT_SHARD_SIZE,
      DEFAULT_UNIT_SHARD_SIZE,
      "MG_TEST_UNIT_SHARD_SIZE"
    ),
    integrationShardSize: positiveInteger(
      environment.MG_TEST_INTEGRATION_SHARD_SIZE,
      DEFAULT_INTEGRATION_SHARD_SIZE,
      "MG_TEST_INTEGRATION_SHARD_SIZE"
    ),
    unitConcurrency: positiveInteger(
      environment.MG_TEST_CONCURRENCY,
      DEFAULT_UNIT_CONCURRENCY,
      "MG_TEST_CONCURRENCY"
    ),
    testTimeoutMs: positiveInteger(
      environment.MG_TEST_FILE_TIMEOUT_MS,
      DEFAULT_TEST_TIMEOUT_MS,
      "MG_TEST_FILE_TIMEOUT_MS"
    ),
    unitShardTimeoutMs: positiveInteger(
      environment.MG_TEST_UNIT_SHARD_TIMEOUT_MS,
      DEFAULT_UNIT_SHARD_TIMEOUT_MS,
      "MG_TEST_UNIT_SHARD_TIMEOUT_MS"
    ),
    integrationShardTimeoutMs: positiveInteger(
      environment.MG_TEST_INTEGRATION_SHARD_TIMEOUT_MS,
      DEFAULT_INTEGRATION_SHARD_TIMEOUT_MS,
      "MG_TEST_INTEGRATION_SHARD_TIMEOUT_MS"
    )
  };
}

export function planTestShards(testFiles, classifyTestFile, options) {
  const unit = [];
  const integration = [];
  for (const file of testFiles) {
    const layer = classifyTestFile(file);
    if (layer === "integration") integration.push(file);
    else unit.push(file);
  }
  return [
    ...distribute(unit, options.unitShardSize).map((files, index) => ({
      id: `unit-${index + 1}`,
      layer: "unit",
      files,
      concurrency: Math.min(options.unitConcurrency, files.length),
      timeoutMs: options.unitShardTimeoutMs
    })),
    ...distribute(integration, options.integrationShardSize).map((files, index) => ({
      id: `integration-${index + 1}`,
      layer: "integration",
      files,
      concurrency: 1,
      timeoutMs: options.integrationShardTimeoutMs
    }))
  ];
}

function distribute(values, maximumSize) {
  const shardCount = Math.ceil(values.length / maximumSize);
  if (shardCount === 0) return [];
  const shards = Array.from({ length: shardCount }, () => []);
  values.forEach((value, index) => shards[index % shardCount].push(value));
  return shards;
}

function positiveInteger(value, fallback, name) {
  if (value === undefined || value === "") return fallback;
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed <= 0) {
    throw new Error(`${name} must be a positive integer`);
  }
  return parsed;
}
