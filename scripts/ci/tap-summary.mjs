export function parseTapTestCount(output) {
  const matches = [...output.matchAll(/^(?:#|ℹ)\s+tests\s+(\d+)\s*$/gm)];
  return Number(matches.at(-1)?.[1] ?? 0);
}

export function parseTapDurations(output) {
  const results = [];
  const pendingSubtests = [];
  for (const line of output.split(/\r?\n/)) {
    const compact = line.match(/^[✔✖]\s+(.+)\s+\(([\d.]+)ms\)\s*$/);
    if (compact) {
      results.push({ name: compact[1], durationMs: Number(compact[2]) });
      continue;
    }
    const subtest = line.match(/^# Subtest: (.+)$/);
    if (subtest) {
      pendingSubtests.push(subtest[1]);
      continue;
    }
    const duration = line.match(/^\s*duration_ms:\s*([\d.]+)/);
    if (duration && pendingSubtests.length > 0) {
      results.push({ name: pendingSubtests.shift(), durationMs: Number(duration[1]) });
    }
  }
  return results;
}
