#!/usr/bin/env bun
import { readdir, writeFile } from "node:fs/promises";
import path from "node:path";

async function main() {
  const root = path.resolve(import.meta.dir, "..");
  const llmDocs = path.join(root, "llm-docs");
  const entries = await readdir(llmDocs, { withFileTypes: true });
  const versions = entries
    .filter((e) => e.isDirectory())
    .map((e) => e.name)
    .filter((n) => /^\d+\.\d+\.\d+$/.test(n))
    .sort((a, b) => {
      const pa = a.split(".").map(Number);
      const pb = b.split(".").map(Number);
      for (let i = 0; i < 3; i++) {
        const d = (pb[i] ?? 0) - (pa[i] ?? 0);
        if (d) return d;
      }
      return 0;
    });

  const items = versions
    .map(
      (v) =>
        `<li><a href="./${v}/README.md">${v}</a> (<a href="./${v}/SEARCH.md">SEARCH</a>)</li>`,
    )
    .join("\n");

  const html = `<!doctype html>
<html>
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>factorio-llm-docs</title>
  <style>
    body { font-family: system-ui, -apple-system, Segoe UI, Roboto, sans-serif; padding: 24px; max-width: 860px; margin: 0 auto; }
    code { background: #f3f3f3; padding: 2px 6px; border-radius: 6px; }
  </style>
</head>
<body>
  <h1>factorio-llm-docs</h1>
  <p>Generated LLM-friendly Factorio API docs (Markdown + chunks).</p>
  <p>Browse: <code>llm-docs/&lt;version&gt;/README.md</code> or <code>llm-docs/&lt;version&gt;/SEARCH.md</code>.</p>
  <h2>Versions</h2>
  <ul>
${items || "<li>(none)</li>"}
  </ul>
</body>
</html>
`;

  await writeFile(path.join(llmDocs, "index.html"), html, "utf8");
}

main().catch((err) => {
  console.error(err?.stack ?? String(err));
  process.exit(1);
});
