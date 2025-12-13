#!/usr/bin/env bun
import { readdir, writeFile } from "node:fs/promises";
import path from "node:path";

function cmpSemverDesc(a: string, b: string) {
  const pa = a.split(".").map(Number);
  const pb = b.split(".").map(Number);
  for (let i = 0; i < 3; i++) {
    const d = (pb[i] ?? 0) - (pa[i] ?? 0);
    if (d) return d;
  }
  return 0;
}

async function main() {
  const root = path.resolve(import.meta.dir, "..");
  const llmDocs = path.join(root, "llm-docs");
  const entries = await readdir(llmDocs, { withFileTypes: true });
  const versions = entries
    .filter((e) => e.isDirectory())
    .map((e) => e.name)
    .filter((n) => /^\d+\.\d+\.\d+$/.test(n))
    .sort(cmpSemverDesc);

  const items = versions
    .map((v) => `<li><a href="./${v}/index.html">${v}</a> (<a href="./${v}/SEARCH.html">SEARCH</a>)</li>`)
    .join("\n");

  const html = `<!doctype html>
<html>
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>factorio-llm-docs</title>
  <style>
    body { font-family: system-ui, -apple-system, Segoe UI, Roboto, sans-serif; padding: 24px; max-width: 980px; margin: 0 auto; line-height: 1.45; }
    code { background: #f3f4f6; padding: 2px 6px; border-radius: 6px; }
    a { color: #2563eb; text-decoration: none; }
    a:hover { text-decoration: underline; }
    .grid { display: grid; grid-template-columns: 1fr; gap: 18px; }
    @media (min-width: 900px) { .grid { grid-template-columns: 1.2fr 0.8fr; } }
    .card { border: 1px solid #e5e7eb; border-radius: 14px; padding: 16px 18px; }
    h1,h2 { margin: 0 0 10px 0; }
    ul { margin: 8px 0 0 18px; }
    .muted { color: #4b5563; }
  </style>
</head>
<body>
  <h1>factorio-llm-docs</h1>
  <p class="muted">Generated Factorio API docs for humans (HTML) and agents (Markdown/JSONL).</p>

  <div class="grid">
    <div class="card">
      <h2>Browse (Humans)</h2>
      <p>Pick a version to browse the docs as HTML:</p>
      <ul>
        ${items || "<li>(none)</li>"}
      </ul>
    </div>

    <div class="card">
      <h2>Use (Agents)</h2>
      <p>GitHub Pages is for browsing. For AI agents and tooling, prefer the source artifacts:</p>
      <ul>
        <li><code>llm-docs/&lt;version&gt;/chunks.jsonl</code> — best for RAG ingestion</li>
        <li><code>llm-docs/&lt;version&gt;/*.md</code> — readable canonical text</li>
        <li><code>llm-docs/&lt;version&gt;/SEARCH.md</code> — curated jump list</li>
        <li><a href="./AGENTS.md">llm-docs/AGENTS.md</a> — agent notes and retrieval tips</li>
      </ul>
      <p class="muted">Tip: retrieve narrowly-scoped chunks (methods/properties) first, then pull the linked markdown page for more context.</p>
    </div>
  </div>
</body>
</html>
`;

  await writeFile(path.join(llmDocs, "index.html"), html, "utf8");
}

main().catch((err) => {
  console.error(err?.stack ?? String(err));
  process.exit(1);
});
