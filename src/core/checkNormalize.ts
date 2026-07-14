import type { CheckNormalizeConfig } from "../types.js";

const ANSI_PATTERN = /\u001b\[[0-?]*[ -/]*[@-~]/g;

export function normalizeCheckOutput(input: string, config: CheckNormalizeConfig = {}): string {
  let output = input;

  if (config.stripAnsi !== false) {
    output = output.replace(ANSI_PATTERN, "");
  }

  if (config.lineEndings === "lf" || config.lineEndings === undefined) {
    output = output.replace(/\r\n/g, "\n");
  }

  for (const preset of config.presets ?? []) {
    output = applyPreset(output, preset);
  }

  for (const replacement of config.replace ?? []) {
    output = output.replace(new RegExp(replacement.pattern, "g"), replacement.replacement);
  }

  if (config.trimWhitespace) {
    output = output.trim();
  }

  return output;
}

function applyPreset(input: string, preset: NonNullable<CheckNormalizeConfig["presets"]>[number]): string {
  switch (preset) {
    case "vitest":
      return input
        .replace(/\b\d+(?:\.\d+)?\s*(?:ms|s)\b/g, "<duration>")
        .replace(/\(\s*\d+\s+tests?\s*\|\s*\d+\s+failed\s*\)/g, "(<test-summary>)")
        .replace(/Duration\s+[\s\S]*?(?=\n\S|\n$)/g, "Duration <normalized>")
        .replace(/Test Files\s+.*$/gm, "Test Files <normalized>")
        .replace(/Tests\s+.*$/gm, "Tests <normalized>")
        .replace(/Start at\s+.*$/gm, "Start at <time>")
        .replace(/^close timed out after <duration>(?:\n|$)/gm, "")
        .replace(/^You can try to identify the cause by enabling "hanging-process" reporter\..*(?:\n|$)/gm, "");
    case "vite":
      return input
        .replace(/\b\d+(?:\.\d+)?\s*(?:ms|s)\b/g, "<duration>")
        .replace(/built in .*/g, "built in <duration>")
        .replace(/dist\/assets\/[\w./-]+-[A-Za-z0-9_-]+\.(js|css|svg|png|jpg|webp)/g, "dist/assets/<asset>.$1")
        .replace(/\s+\d+(?:\.\d+)?\s+kB(?:\s+[│|]\s+gzip:\s+\d+(?:\.\d+)?\s+kB)?/g, " <size>")
        .replace(/^\[PLUGIN_TIMINGS\].*(?:\n|$)/gm, "");
    case "webpack":
      return input
        .replace(/\b\d+(?:\.\d+)?\s*(?:KiB|MiB|bytes)\b/g, "<size>")
        .replace(/webpack\s+[\d.]+\s+compiled\s+(successfully|with \d+ warnings?)\s+in\s+\d+\s*ms/g, "webpack <version> compiled $1 in <duration>")
        .replace(/\b[0-9a-f]{8,}\b/gi, "<hash>");
    case "jest":
      return input
        .replace(/^Time:\s+.*$/gm, "Time: <duration>")
        .replace(/^Ran all test suites.*$/gm, "Ran all test suites <normalized>")
        .replace(/\(\d+(?:\.\d+)?\s*s\)/g, "(<duration>)")
        .replace(/estimated\s+\d+\s*s/gi, "estimated <duration>");
    case "pnpm":
      return input
        .replace(/^Scope:\s+.*$/gm, "Scope: <workspace>")
        .replace(/^[A-Z]:\\[^\n]+(?:packages|apps)\\([^\s:]+):/gm, "<workspace>/$1:")
        .replace(/^\s*\.\.?\\[^\n]+(?:packages|apps)\\([^\s:]+):/gm, "<workspace>/$1:");
    case "go":
      return sortGoDiagnosticBlocks(input
        .replace(/\t\(cached\)$/gm, "\t<duration>")
        .replace(/\t\d+(?:\.\d+)?s$/gm, "\t<duration>"));
    case "paths":
      return input
        .replace(/[A-Z]:\\[^\s)"']+/g, "<path>")
        .replace(/\/(?:[\w.-]+\/)+[\w.-]+/g, "<path>");
    case "timing":
      return input.replace(/\b\d+(?:\.\d+)?\s*(?:ms|s|m)\b/g, "<duration>");
    default:
      return input;
  }
}

function sortGoDiagnosticBlocks(input: string): string {
  const lines = input.split("\n");
  const output: string[] = [];
  let index = 0;

  while (index < lines.length) {
    if (!isGoDiagnosticHeader(lines[index])) {
      output.push(lines[index]);
      index += 1;
      continue;
    }

    const blocks: Array<{ key: string; lines: string[] }> = [];
    while (index < lines.length && isGoDiagnosticHeader(lines[index])) {
      const start = index;
      const key = lines[index];
      index += 1;
      while (index < lines.length && !isGoDiagnosticHeader(lines[index])) {
        index += 1;
      }
      blocks.push({ key, lines: lines.slice(start, index) });
    }

    blocks.sort((a, b) => a.key.localeCompare(b.key) || a.lines.join("\n").localeCompare(b.lines.join("\n")));
    for (const block of blocks) {
      output.push(...block.lines);
    }
  }

  return output.join("\n");
}

function isGoDiagnosticHeader(line: string | undefined): boolean {
  return Boolean(line && /^# (?!\[)/.test(line));
}
