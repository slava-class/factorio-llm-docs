#!/usr/bin/env bun
import { mkdir, readFile, readdir, stat, writeFile } from "node:fs/promises";
import path from "node:path";

function isSemverDir(name: string) {
  return /^\d+\.\d+\.\d+$/.test(name);
}

function escapeHtml(s: string) {
  return s
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

function stripFrontmatter(md: string) {
  if (!md.startsWith("---\n")) return md;
  const end = md.indexOf("\n---\n", 4);
  if (end === -1) return md;
  return md.slice(end + "\n---\n".length);
}

function rewriteMdLinksToHtml(md: string) {
  return md.replace(/\]\(([^)\s]+)\)/g, (m, href) => {
    if (href.startsWith("http://") || href.startsWith("https://")) return m;
    const [p, h] = String(href).split("#", 2);
    if (!p.endsWith(".md")) return m;
    const out = p.slice(0, -3) + ".html";
    return `](${out}${h ? `#${h}` : ""})`;
  });
}

function mdToHtml(md: string) {
  // Very small markdown subset renderer (enough for these docs).
  // Headings, lists, paragraphs, fenced code, inline code.
  const lines = md.split(/\r?\n/);
  const out: string[] = [];

  let inCode = false;
  let codeLang = "";
  let codeBuf: string[] = [];
  let inList = false;

  function flushParagraph(buf: string[]) {
    const text = buf.join(" ").trim();
    if (!text) return;
    const withLinks = text.replace(/\[([^\]]+)\]\(([^)]+)\)/g, (_m, label, href) => {
      return `<a href="${escapeHtml(href)}">${escapeHtml(label)}</a>`;
    });
    const withInlineCode = withLinks.replace(/`([^`]+)`/g, (_m, code) => `<code>${escapeHtml(code)}</code>`);
    out.push(`<p>${withInlineCode}</p>`);
  }

  let paraBuf: string[] = [];

  function flushList() {
    if (!inList) return;
    out.push("</ul>");
    inList = false;
  }

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];

    const fence = line.match(/^```(.*)$/);
    if (fence) {
      if (!inCode) {
        flushParagraph(paraBuf);
        paraBuf = [];
        flushList();
        inCode = true;
        codeLang = fence[1]?.trim() ?? "";
        codeBuf = [];
      } else {
        const cls = codeLang ? ` class=\"language-${escapeHtml(codeLang)}\"` : "";
        out.push(`<pre><code${cls}>${escapeHtml(codeBuf.join("\n"))}</code></pre>`);
        inCode = false;
        codeLang = "";
        codeBuf = [];
      }
      continue;
    }

    if (inCode) {
      codeBuf.push(line);
      continue;
    }

    const h = line.match(/^(#{1,6})\s+(.*)$/);
    if (h) {
      flushParagraph(paraBuf);
      paraBuf = [];
      flushList();
      const level = h[1].length;
      const text = h[2].trim();
      const id = text
        .toLowerCase()
        .replace(/[^a-z0-9\s-]/g, "")
        .trim()
        .replace(/\s+/g, "-");
      out.push(`<h${level} id="${escapeHtml(id)}">${escapeHtml(text)}</h${level}>`);
      continue;
    }

    const li = line.match(/^\s*-\s+(.*)$/);
    if (li) {
      flushParagraph(paraBuf);
      paraBuf = [];
      if (!inList) {
        out.push("<ul>");
        inList = true;
      }
      const item = li[1].trim();
      const withLinks = item.replace(/\[([^\]]+)\]\(([^)]+)\)/g, (_m, label, href) => {
        return `<a href="${escapeHtml(href)}">${escapeHtml(label)}</a>`;
      });
      const withInlineCode = withLinks.replace(/`([^`]+)`/g, (_m, code) => `<code>${escapeHtml(code)}</code>`);
      out.push(`<li>${withInlineCode}</li>`);
      continue;
    }

    if (line.trim() === "") {
      flushParagraph(paraBuf);
      paraBuf = [];
      flushList();
      continue;
    }

    paraBuf.push(line.trim());
  }

  flushParagraph(paraBuf);
  flushList();

  return out.join("\n");
}

async function walkFiles(dir: string): Promise<string[]> {
  const entries = await readdir(dir, { withFileTypes: true });
  const out: string[] = [];
  for (const e of entries) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) {
      out.push(...(await walkFiles(p)));
    } else {
      out.push(p);
    }
  }
  return out;
}

function htmlTemplate(title: string, body: string, rootRel: string) {
  return `<!doctype html>
<html>
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>${escapeHtml(title)}</title>
  <style>
    body { font-family: system-ui, -apple-system, Segoe UI, Roboto, sans-serif; padding: 24px; max-width: 980px; margin: 0 auto; line-height: 1.45; }
    a { color: #2563eb; text-decoration: none; }
    a:hover { text-decoration: underline; }
    code { background: #f3f4f6; padding: 2px 6px; border-radius: 6px; }
    pre { background: #0b1020; color: #e5e7eb; padding: 14px; border-radius: 10px; overflow: auto; }
    pre code { background: transparent; padding: 0; }
    .top { margin-bottom: 18px; }
    .top a { margin-right: 12px; }
    hr { border: 0; border-top: 1px solid #e5e7eb; margin: 18px 0; }
  </style>
</head>
<body>
  <div class="top">
    <a href="${rootRel}index.html">Home</a>
  </div>
  <hr />
  ${body}
</body>
</html>
`;
}

async function writeVersionIndex(versionDir: string, version: string) {
  const body = `
<h1>Factorio ${escapeHtml(version)}</h1>
<ul>
  <li><a href="./SEARCH.html">Search Guide</a></li>
  <li><a href="./runtime/classes/index.html">Runtime Classes</a></li>
  <li><a href="./runtime/events/index.html">Runtime Events</a></li>
  <li><a href="./runtime/concepts/index.html">Runtime Concepts</a></li>
  <li><a href="./runtime/defines/index.html">Runtime Defines</a></li>
  <li><a href="./prototype/prototypes/index.html">Prototype Prototypes</a></li>
  <li><a href="./prototype/types/index.html">Prototype Types</a></li>
  <li><a href="./prototype/defines/index.html">Prototype Defines</a></li>
  <li><a href="./auxiliary/mod-structure.html">Auxiliary: Mod Structure</a></li>
  <li><a href="./auxiliary/data-lifecycle.html">Auxiliary: Data Lifecycle</a></li>
</ul>
`;
  await writeFile(path.join(versionDir, "index.html"), htmlTemplate(`Factorio ${version}`, body, "../"), "utf8");
}

async function main() {
  const repoRoot = path.resolve(import.meta.dir, "..");
  const llmRoot = path.join(repoRoot, "llm-docs");
  const entries = await readdir(llmRoot, { withFileTypes: true });
  const versions = entries.filter((e) => e.isDirectory() && isSemverDir(e.name)).map((e) => e.name);

  for (const version of versions) {
    const versionDir = path.join(llmRoot, version);
    await writeVersionIndex(versionDir, version);

    const files = await walkFiles(versionDir);
    for (const f of files) {
      if (!f.endsWith(".md")) continue;
      const relFromVersion = path.relative(versionDir, f);
      const outPath = path.join(versionDir, relFromVersion.slice(0, -3) + ".html");
      await mkdir(path.dirname(outPath), { recursive: true });

      const raw = await readFile(f, "utf8");
      const cleaned = rewriteMdLinksToHtml(stripFrontmatter(raw));
      const body = mdToHtml(cleaned);

      const title = path.basename(f, ".md");
      const rootRel = "../".repeat(path.relative(versionDir, path.dirname(outPath)).split(path.sep).filter(Boolean).length + 1);
      await writeFile(outPath, htmlTemplate(title, body, rootRel), "utf8");
    }
  }
}

main().catch((err) => {
  console.error(err?.stack ?? String(err));
  process.exit(1);
});
