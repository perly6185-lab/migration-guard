import crypto from "node:crypto";
import path from "node:path";
import { pathToFileURL } from "node:url";

const targetRoot = process.env.MD_TARGET_ROOT || process.cwd();

function targetModule(relativePath) {
  return pathToFileURL(path.join(targetRoot, relativePath)).href;
}

function sha256(value) {
  return crypto.createHash("sha256").update(value).digest("hex");
}

function mockDoc(lines) {
  return {
    lines: lines.length,
    line: (number) => ({ text: lines[number - 1] ?? "" })
  };
}

const { initRenderer } = await import(targetModule("packages/core/src/renderer/renderer-impl.ts"));
const { renderMarkdown, postProcessHtml } = await import(targetModule("packages/core/src/utils/markdownHelpers.ts"));
const { extractMarkdownHeadings, computeHeadingBreadcrumbs } = await import(targetModule("apps/web/src/lib/markdown/headings.ts"));

const renderer = initRenderer({ countStatus: true, isMacCodeBlock: false });
const markdown = [
  "---",
  "title: Probe",
  "---",
  "",
  "# Hello",
  "",
  "> [!NOTE]",
  "> Alert body",
  "",
  "<script>alert(1)</script>",
  "",
  "$$E=mc^2$$"
].join("\n");

const { html, readingTime } = renderMarkdown(markdown, renderer);
const processed = postProcessHtml(html, readingTime, renderer);
const parsed = renderer.parseFrontMatterAndContent("---\ntitle: Test\n---\n\n# Body");

const doc = mockDoc([
  "---",
  "title: \"# Fake\"",
  "---",
  "# Body",
  "```",
  "# Not Heading",
  "```",
  "## Section",
  "### Detail"
]);
const headings = extractMarkdownHeadings(doc);
const breadcrumbs = computeHeadingBreadcrumbs(headings, 9);

const result = {
  renderer: {
    hasHeading: html.includes("<h1"),
    hasAlert: html.includes("markdown-alert"),
    hasKatexBlock: html.includes("katex-block"),
    strippedScript: !html.includes("<script>"),
    htmlHash: sha256(html),
    processedHash: sha256(processed),
    readingWords: readingTime.words
  },
  frontMatter: {
    markdownContent: parsed.markdownContent.trim(),
    readingWordsPositive: parsed.readingTime.words > 0
  },
  headings: {
    extracted: headings,
    breadcrumbs
  }
};

console.log(JSON.stringify(result));
