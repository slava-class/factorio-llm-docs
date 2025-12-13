#!/usr/bin/env bun
import { createWriteStream, existsSync } from "node:fs";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";

type Stage = "runtime" | "prototype";

type ResolverEntry = {
  relPath: string;
};

type ResolveResult = {
  relPath: string;
  anchor?: string;
};

type ChunkRecord = {
  id: string;
  version: string;
  stage: Stage | "auxiliary";
  kind: string;
  name: string;
  member?: string;
  relMarkdownPath?: string;
  anchor?: string;
  text: string;
};

function toTitleCaseFromSlug(slug: string) {
  return slug
    .split(/[-_]+/g)
    .filter(Boolean)
    .map((w) => w.slice(0, 1).toUpperCase() + w.slice(1))
    .join(" ");
}

function auxiliaryTitle(base: string) {
  if (base === "json-docs-runtime") return "Runtime JSON Format";
  if (base === "json-docs-prototype") return "Prototype JSON Format";
  return toTitleCaseFromSlug(base);
}

function stripLeadingDuplicateHeading(md: string, title: string) {
  const t = title.trim();
  const lines = normalizeNewlines(md).split("\n");
  if (!lines.length) return md;

  // Skip initial blank lines.
  let i = 0;
  while (i < lines.length && lines[i].trim() === "") i++;

  const h2 = `## ${t}`;
  const h1 = `# ${t}`;

  if (lines[i] === h2 || lines[i] === h1) {
    i++;
    // Remove subsequent blank lines.
    while (i < lines.length && lines[i].trim() === "") i++;
    return lines.slice(i).join("\n").trim() + "\n";
  }

  return md;
}

function indexTitle(stage: Stage, kind: string) {
  const stageTitle = stage === "runtime" ? "Runtime" : "Prototype";
  const kindTitle = toTitleCaseFromSlug(kind);
  return `${stageTitle} ${kindTitle}`;
}

function parseArgs(argv: string[]) {
  const args: {
    outDir: string;
    force: boolean;
    version?: string;
    only?: Array<"runtime" | "prototype" | "auxiliary">;
  } = { outDir: "llm-docs", force: false };

  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--out" || a === "-o") {
      args.outDir = argv[++i] ?? args.outDir;
      continue;
    }
    if (a === "--force" || a === "-f") {
      args.force = true;
      continue;
    }
    if (a === "--version") {
      args.version = argv[++i];
      continue;
    }
    if (a === "--only") {
      const v = argv[++i] ?? "";
      const parts = v
        .split(",")
        .map((s) => s.trim())
        .filter(Boolean) as Array<"runtime" | "prototype" | "auxiliary">;
      args.only = parts.length ? parts : undefined;
      continue;
    }
    if (a === "--help" || a === "-h") {
      printHelpAndExit();
    }
    throw new Error(`Unknown arg: ${a}`);
  }

  return args;
}

function printHelpAndExit(code = 0): never {
  console.log(`factorio-api-docs-to-llm

Usage:
  bun tools/factorio-api-docs-to-llm.ts [options]

Options:
  --out, -o <dir>       Output directory (default: llm-docs)
  --version <version>   Override docs version directory name
  --only <list>         Comma-separated: runtime,prototype,auxiliary
  --force, -f           Overwrite existing output version dir
  --help, -h            Show help
`);
  process.exit(code);
}

function decodeHtmlEntities(s: string) {
  return s
    .replaceAll("&lt;", "<")
    .replaceAll("&gt;", ">")
    .replaceAll("&amp;", "&")
    .replaceAll("&quot;", '"')
    .replaceAll("&#39;", "'");
}

function stripTags(s: string) {
  return s.replace(/<[^>]+>/g, "");
}

function normalizeNewlines(s: string) {
  return s.replace(/\r\n?/g, "\n");
}

function toPosix(p: string) {
  return p.split(path.sep).join("/");
}

function relLink(fromRelPath: string, toRelPath: string) {
  const fromDir = path.posix.dirname(fromRelPath);
  const rel = path.posix.relative(fromDir, toRelPath);
  return rel.length ? rel : path.posix.basename(toRelPath);
}

function renderFrontmatter(data: Record<string, unknown>) {
  const lines = Object.entries(data).map(([k, v]) => `${k}: ${String(v)}`);
  return `---\n${lines.join("\n")}\n---\n`;
}

function typeToString(t: unknown): string {
  if (typeof t === "string") return t;
  if (!t || typeof t !== "object") return String(t);

  const obj = t as Record<string, unknown>;
  const complexType = obj["complex_type"];
  if (typeof complexType !== "string") return JSON.stringify(t);

  switch (complexType) {
    case "array":
      return `Array<${typeToString(obj["value"])}>`;
    case "dictionary":
      return `Dict<${typeToString(obj["key"])}, ${typeToString(obj["value"])}>`;
    case "tuple": {
      const values = Array.isArray(obj["values"]) ? (obj["values"] as unknown[]) : [];
      return `Tuple<${values.map(typeToString).join(", ")}>`;
    }
    case "union": {
      const options = Array.isArray(obj["options"]) ? (obj["options"] as unknown[]) : [];
      return options.map(typeToString).join(" | ") || "union";
    }
    case "literal":
      return JSON.stringify(obj["value"]);
    case "table": {
      const params = Array.isArray(obj["parameters"]) ? (obj["parameters"] as any[]) : [];
      const pieces = params.map((p) => {
        const name = String(p?.name ?? "value");
        const optional = p?.optional ? "?" : "";
        return `${name}${optional}: ${typeToString(p?.type)}`;
      });
      return `{ ${pieces.join(", ")} }`;
    }
    case "function": {
      const params = Array.isArray(obj["parameters"]) ? (obj["parameters"] as unknown[]) : [];
      const returns = Array.isArray(obj["return_values"]) ? (obj["return_values"] as unknown[]) : [];
      const ret = returns.length ? ` -> ${returns.map(typeToString).join(", ")}` : "";
      return `function(${params.map(typeToString).join(", ")})${ret}`;
    }
    case "type":
      return typeToString(obj["value"]);
    case "LuaStruct": {
      const attrs = Array.isArray(obj["attributes"]) ? (obj["attributes"] as any[]) : [];
      const pieces = attrs.map((a) => `${a.name}${a.optional ? "?" : ""}: ${a.read_type ?? a.write_type ?? "unknown"}`);
      return `LuaStruct{ ${pieces.join(", ")} }`;
    }
    case "LuaCustomTable":
      return `LuaCustomTable<${typeToString(obj["key"])}, ${typeToString(obj["value"])}>`;
    case "LuaLazyLoadedValue":
      return `LuaLazyLoadedValue<${typeToString(obj["value"])}>`;
    case "builtin":
      return "builtin";
    case "struct":
      return "struct";
    default:
      return complexType;
  }
}

function renderSignature(name: string, parameters: any[] | undefined, returnValues: any[] | undefined) {
  const params = (parameters ?? []).map((p) => {
    const optional = p.optional ? "?" : "";
    return `${p.name}${optional}: ${typeToString(p.type)}`;
  });
  const rets = (returnValues ?? []).map((r) => `${typeToString(r.type)}${r.optional ? "?" : ""}`);
  return `${name}(${params.join(", ")})${rets.length ? ` -> ${rets.join(", ")}` : ""}`;
}

function convertInternalLinks(md: string, fromRelPath: string, resolve: (target: string) => ResolveResult | null) {
  return md.replace(/\[([^\]]+)\]\((runtime|prototype):([^)]+)\)/g, (_m, label, stage, rest) => {
    const target = `${stage}:${rest}`;
    const resolved = resolve(target);
    if (!resolved) return `[${label}](${target})`;
    const href = relLink(fromRelPath, resolved.relPath) + (resolved.anchor ? `#${resolved.anchor}` : "");
    return `[${label}](${href})`;
  });
}

function convertSiteHtmlLinks(md: string, fromRelPath: string, resolve: (target: string) => ResolveResult | null) {
  return md.replace(/\[([^\]]+)\]\(([^)\s]+)\)/g, (_m, label, href) => {
    const [rawPath, rawHash] = href.split("#", 2);
    const hash = rawHash ? `#${rawHash}` : "";

    // Auxiliary pages referenced directly (e.g. libraries.html).
    const auxMatch = rawPath.match(/^([a-z0-9-]+)\.html$/i);
    if (auxMatch) {
      const base = auxMatch[1];
      const resolved = resolve(`auxiliary:${base}`);
      if (resolved) return `[${label}](${relLink(fromRelPath, resolved.relPath)}${hash})`;
      return `[${label}](${href})`;
    }

    // defines.html#defines.NAME[.sub...]
    if ((rawPath === "defines.html" || rawPath === "../defines.html") && rawHash?.startsWith("defines.")) {
      const parts = rawHash.split(".");
      const defineName = parts[1];
      const suffix = parts.length > 2 ? `#${parts.slice(2).join(".")}` : "";
      const stageHint: Stage = fromRelPath.includes("/prototype/") ? "prototype" : "runtime";
      const resolved = resolve(`${stageHint}:defines.${defineName}`);
      if (resolved) return `[${label}](${relLink(fromRelPath, resolved.relPath)}${suffix})`;
      return `[${label}](${href})`;
    }

    // Stage overview pages (classes.html, concepts.html, etc).
    const overviewMatch = rawPath.match(/^(\.\.\/)?(classes|concepts|events|prototypes|types|defines)\.html$/i);
    if (overviewMatch) {
      const kind = overviewMatch[2];
      const stageHint: Stage = kind === "prototypes" || kind === "types" ? "prototype" : "runtime";
      const resolved = resolve(`${stageHint}:${kind}`);
      if (resolved) return `[${label}](${relLink(fromRelPath, resolved.relPath)}${hash})`;
      return `[${label}](${href})`;
    }

    // Member pages from the original site structure.
    const memberMatch = rawPath.match(/^\.\.\/(classes|concepts|events|prototypes|types)\/([^/]+)\.html$/i);
    if (memberMatch) {
      const kind = memberMatch[1];
      const name = memberMatch[2];
      const stageHint: Stage = kind === "prototypes" || kind === "types" ? "prototype" : "runtime";
      const resolved = resolve(`${stageHint}:${name}`);
      if (resolved) return `[${label}](${relLink(fromRelPath, resolved.relPath)}${hash})`;
      return `[${label}](${href})`;
    }

    return `[${label}](${href})`;
  });
}

function htmlToMarkdown(html: string) {
  let s = normalizeNewlines(html);
  const footerIndex = s.lastIndexOf('<div class="footer">');
  if (footerIndex !== -1) s = s.slice(0, footerIndex);
  const startIndex = s.indexOf("<h2");
  if (startIndex !== -1) s = s.slice(startIndex);
  const sidebarIndexCandidates = [
    s.indexOf('<div class="docs-sidebar'),
    s.indexOf('<div class="docs-sidebar-thin'),
  ].filter((n) => n !== -1);
  if (sidebarIndexCandidates.length) {
    s = s.slice(0, Math.min(...sidebarIndexCandidates));
  }

  function rewriteHref(href: string) {
    const [base, hash] = href.split("#", 2);
    let out = base;

    // Map the original HTML site structure to this export's structure.
    out = out.replace(/^\.\.\/classes\.(html|md)$/i, "../runtime/classes/index.md");
    out = out.replace(/^\.\.\/concepts\.(html|md)$/i, "../runtime/concepts/index.md");
    out = out.replace(/^\.\.\/events\.(html|md)$/i, "../runtime/events/index.md");
    out = out.replace(/^\.\.\/prototypes\.(html|md)$/i, "../prototype/prototypes/index.md");
    out = out.replace(/^\.\.\/types\.(html|md)$/i, "../prototype/types/index.md");
    out = out.replace(/^\.\.\/defines\.(html|md)$/i, "../runtime/defines/index.md");

    out = out.replace(/^\.\.\/classes\//, "../runtime/classes/");
    out = out.replace(/^\.\.\/concepts\//, "../runtime/concepts/");
    out = out.replace(/^\.\.\/events\//, "../runtime/events/");
    out = out.replace(/^\.\.\/prototypes\//, "../prototype/prototypes/");
    out = out.replace(/^\.\.\/types\//, "../prototype/types/");

    // defines.html#defines.NAME -> ../runtime/defines/NAME.md
    if (out === "../defines.html" && hash?.startsWith("defines.")) {
      const parts = hash.split(".");
      const defineName = parts[1];
      if (defineName) out = `../runtime/defines/${defineName}.md`;
      return out;
    }

    // Auxiliary pages are siblings, so storage.html -> storage.md.
    if (out.endsWith(".html")) out = out.slice(0, -5) + ".md";
    return hash ? `${out}#${hash}` : out;
  }

  // Code blocks first.
  s = s.replace(/<pre><code[^>]*>([\s\S]*?)<\/code><\/pre>/g, (_m, code) => {
    const decoded = decodeHtmlEntities(code);
    return `\n\`\`\`\n${decoded}\n\`\`\`\n`;
  });

  // Links.
  s = s.replace(/<a [^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/g, (_m, href, inner) => {
    const text = decodeHtmlEntities(stripTags(inner)).trim();
    if (!text) return "";
    return `[${text}](${rewriteHref(href)})`;
  });

  // Inline code.
  s = s.replace(/<code>([\s\S]*?)<\/code>/g, (_m, inner) => {
    const text = decodeHtmlEntities(stripTags(inner));
    if (text.includes("\n")) return `\n\`\`\`\n${text}\n\`\`\`\n`;
    return `\`${text}\``;
  });

  // Headings.
  for (let level = 1; level <= 6; level++) {
    const re = new RegExp(`<h${level}[^>]*>([\\s\\S]*?)<\\/h${level}>`, "g");
    s = s.replace(re, (_m, inner) => {
      const text = decodeHtmlEntities(stripTags(inner)).trim();
      if (!text) return "";
      return `\n${"#".repeat(level)} ${text}\n`;
    });
  }

  // Lists.
  s = s.replace(/<\/li>/g, "\n");
  s = s.replace(/<li[^>]*>/g, "- ");
  s = s.replace(/<\/p>/g, "\n\n");
  s = s.replace(/<p[^>]*>/g, "");

  // Everything else.
  s = decodeHtmlEntities(stripTags(s));

  // Cleanup.
  s = s.replace(/\n{3,}/g, "\n\n").trim() + "\n";
  return s;
}

async function writeTextFile(outRootAbs: string, relPath: string, content: string) {
  const abs = path.join(outRootAbs, relPath);
  await mkdir(path.dirname(abs), { recursive: true });
  await writeFile(abs, content, "utf8");
}

function buildResolverMaps(outVersionRootRel: string, auxiliaryBasenames: string[]) {
  const map = new Map<string, ResolverEntry>();
  for (const name of auxiliaryBasenames) {
    map.set(`auxiliary:${name}`, { relPath: path.posix.join(outVersionRootRel, "auxiliary", `${name}.md`) });
    map.set(`runtime:${name}`, { relPath: path.posix.join(outVersionRootRel, "auxiliary", `${name}.md`) });
    map.set(`prototype:${name}`, { relPath: path.posix.join(outVersionRootRel, "auxiliary", `${name}.md`) });
  }

  // Overview pages (internal-link targets like runtime:events).
  map.set("runtime:classes", { relPath: path.posix.join(outVersionRootRel, "runtime", "classes", "index.md") });
  map.set("runtime:concepts", { relPath: path.posix.join(outVersionRootRel, "runtime", "concepts", "index.md") });
  map.set("runtime:events", { relPath: path.posix.join(outVersionRootRel, "runtime", "events", "index.md") });
  map.set("runtime:defines", { relPath: path.posix.join(outVersionRootRel, "runtime", "defines", "index.md") });
  map.set("prototype:prototypes", { relPath: path.posix.join(outVersionRootRel, "prototype", "prototypes", "index.md") });
  map.set("prototype:types", { relPath: path.posix.join(outVersionRootRel, "prototype", "types", "index.md") });
  map.set("prototype:defines", { relPath: path.posix.join(outVersionRootRel, "prototype", "defines", "index.md") });

  return map;
}

function makeResolve(map: Map<string, ResolverEntry>) {
  return (target: string): ResolveResult | null => {
    const firstColon = target.indexOf(":");
    const stage = firstColon === -1 ? "" : target.slice(0, firstColon);
    const rest = firstColon === -1 ? "" : target.slice(firstColon + 1);
    if (!rest) return null;

    if ((stage === "runtime" || stage === "prototype") && rest.startsWith("defines.")) {
      const parts = rest.slice("defines.".length).split(".");
      const defineName = parts[0];
      const entry = map.get(`${stage}:defines.${defineName}`);
      if (!entry) return null;
      const anchor = parts.length > 1 ? parts.slice(1).join(".") : undefined;
      return { relPath: entry.relPath, anchor };
    }

    if ((stage === "runtime" || stage === "prototype") && rest.includes("::")) {
      const [base, member] = rest.split("::", 2);
      const entry = map.get(`${stage}:${base}`) ?? map.get(`auxiliary:${base}`);
      if (!entry) return null;
      return { relPath: entry.relPath, anchor: member };
    }

    const entry = map.get(target) ?? map.get(`auxiliary:${rest}`);
    if (!entry) return null;
    return { relPath: entry.relPath };
  };
}

async function main() {
  const args = parseArgs(Bun.argv.slice(2));
  const cwd = process.cwd();

  const runtimeJsonPath = path.join(cwd, "runtime-api.json");
  const prototypeJsonPath = path.join(cwd, "prototype-api.json");

  const runtimeJsonText = existsSync(runtimeJsonPath) ? await readFile(runtimeJsonPath, "utf8") : null;
  const prototypeJsonText = existsSync(prototypeJsonPath) ? await readFile(prototypeJsonPath, "utf8") : null;

  const runtimeObj = runtimeJsonText ? (JSON.parse(runtimeJsonText) as any) : null;
  const prototypeObj = prototypeJsonText ? (JSON.parse(prototypeJsonText) as any) : null;

  if (!runtimeObj && !prototypeObj) {
    throw new Error("Expected runtime-api.json and/or prototype-api.json in the current directory.");
  }

  const detectedVersion: string | undefined =
    args.version ?? runtimeObj?.application_version ?? prototypeObj?.application_version;
  if (!detectedVersion) throw new Error("Could not determine application_version.");

  const outDirAbs = path.join(cwd, args.outDir);
  const outVersionAbs = path.join(outDirAbs, detectedVersion);
  const outVersionRel = toPosix(path.relative(cwd, outVersionAbs));

  if (existsSync(outVersionAbs) && !args.force) {
    throw new Error(`Output already exists: ${outVersionAbs} (use --force to overwrite)`);
  }

  if (existsSync(outVersionAbs) && args.force) {
    await rm(outVersionAbs, { recursive: true, force: true });
  }
  await mkdir(outVersionAbs, { recursive: true });

  const auxiliaryDirAbs = path.join(cwd, "auxiliary");
  const auxiliaryBasenames: string[] = existsSync(auxiliaryDirAbs)
    ? (await Bun.$`ls -1 ${auxiliaryDirAbs}`.text())
        .split("\n")
        .map((s) => s.trim())
        .filter((s) => s.endsWith(".html"))
        .map((s) => s.replace(/\.html$/i, ""))
        .sort()
    : [];

  const resolverMap = buildResolverMaps(outVersionRel, auxiliaryBasenames);

  // Populate runtime/prototype resolver entries (base symbol -> file path).
  if (runtimeObj) {
    for (const c of runtimeObj.classes ?? []) resolverMap.set(`runtime:${c.name}`, { relPath: path.posix.join(outVersionRel, "runtime", "classes", `${c.name}.md`) });
    for (const c of runtimeObj.concepts ?? []) resolverMap.set(`runtime:${c.name}`, { relPath: path.posix.join(outVersionRel, "runtime", "concepts", `${c.name}.md`) });
    for (const e of runtimeObj.events ?? []) resolverMap.set(`runtime:${e.name}`, { relPath: path.posix.join(outVersionRel, "runtime", "events", `${e.name}.md`) });
    for (const d of runtimeObj.defines ?? []) resolverMap.set(`runtime:defines.${d.name}`, { relPath: path.posix.join(outVersionRel, "runtime", "defines", `${d.name}.md`) });
    for (const f of runtimeObj.global_functions ?? []) resolverMap.set(`runtime:${f.name}`, { relPath: path.posix.join(outVersionRel, "runtime", "global_functions", `${f.name}.md`) });
    for (const o of runtimeObj.global_objects ?? []) resolverMap.set(`runtime:${o.name}`, { relPath: path.posix.join(outVersionRel, "runtime", "global_objects", `${o.name}.md`) });
  }
  if (prototypeObj) {
    for (const p of prototypeObj.prototypes ?? []) resolverMap.set(`prototype:${p.name}`, { relPath: path.posix.join(outVersionRel, "prototype", "prototypes", `${p.name}.md`) });
    for (const t of prototypeObj.types ?? []) resolverMap.set(`prototype:${t.name}`, { relPath: path.posix.join(outVersionRel, "prototype", "types", `${t.name}.md`) });
    for (const d of prototypeObj.defines ?? []) resolverMap.set(`prototype:defines.${d.name}`, { relPath: path.posix.join(outVersionRel, "prototype", "defines", `${d.name}.md`) });
  }

  const resolve = makeResolve(resolverMap);

  const only = new Set(args.only ?? ["runtime", "prototype", "auxiliary"]);

  const chunksPathAbs = path.join(outVersionAbs, "chunks.jsonl");
  const chunksRel = toPosix(path.relative(cwd, chunksPathAbs));
  const chunksStream = createWriteStream(chunksPathAbs, { encoding: "utf8" });

  const stats = {
    version: detectedVersion,
    generated_at: new Date().toISOString(),
    outputs: {
      markdown_root: outVersionRel,
      chunks_jsonl: chunksRel,
    },
    counts: {
      runtime: { classes: 0, concepts: 0, events: 0, defines: 0, global_functions: 0, global_objects: 0 },
      prototype: { prototypes: 0, types: 0, defines: 0 },
      auxiliary: { pages: auxiliaryBasenames.length },
      chunks: 0,
    },
  };

  function writeChunk(rec: ChunkRecord) {
    const convertedText = rec.relMarkdownPath
      ? convertSiteHtmlLinks(convertInternalLinks(rec.text, rec.relMarkdownPath, resolve), rec.relMarkdownPath, resolve)
      : rec.text;
    chunksStream.write(`${JSON.stringify({ ...rec, text: convertedText })}\n`);
    stats.counts.chunks++;
  }

  async function writeSymbolMarkdown(
    stage: Stage | "auxiliary",
    kind: string,
    name: string,
    relPath: string,
    body: string,
    source: string,
  ) {
    const fromRel = relPath;
    const convertedBody = convertSiteHtmlLinks(convertInternalLinks(body, fromRel, resolve), fromRel, resolve);
    const content =
      renderFrontmatter({ version: detectedVersion, stage, kind, name, source }) + "\n" + convertedBody.trim() + "\n";
    await writeTextFile(outVersionAbs, path.posix.relative(outVersionRel, relPath), content);
  }

  function mdSection(title: string) {
    return `\n## ${title}\n`;
  }

  async function writeIndex(
    stage: Stage,
    kind: "classes" | "concepts" | "events" | "defines" | "prototypes" | "types",
    items: Array<{ name: string; description?: string }>,
  ) {
    const rel =
      stage === "runtime"
        ? path.posix.join(outVersionRel, "runtime", kind, "index.md")
        : path.posix.join(outVersionRel, "prototype", kind, "index.md");
    const title = indexTitle(stage, kind);
    const rows = items
      .slice()
      .sort((a, b) => a.name.localeCompare(b.name))
      .map((it) => {
        const target = `./${it.name}.md`;
        const desc = (it.description ?? "").split("\n")[0].trim();
        return `- [\`${it.name}\`](${target})${desc ? ` — ${desc}` : ""}`;
      })
      .join("\n");

    const md = `# ${title}\n\n${rows}\n`;
    await writeSymbolMarkdown(stage, `${kind}_index`, title, rel, md, stage === "runtime" ? "runtime-api.json" : "prototype-api.json");
    writeChunk({
      id: `${detectedVersion}/${stage}/${kind}/index`,
      version: detectedVersion,
      stage,
      kind: `${kind}_index`,
      name: title,
      relMarkdownPath: rel,
      text: md,
    });
  }

  function mdFieldList(items: Array<{ name: string; type?: string; optional?: boolean; description?: string }>) {
    if (!items.length) return "";
    return items
      .map((i) => `- \`${i.name}${i.optional ? "?" : ""}\`: \`${i.type ?? "unknown"}\`${i.description ? ` — ${i.description}` : ""}`)
      .join("\n");
  }

  if (only.has("auxiliary")) {
    for (const base of auxiliaryBasenames) {
      const srcAbs = path.join(auxiliaryDirAbs, `${base}.html`);
      const html = await readFile(srcAbs, "utf8");
      const title = auxiliaryTitle(base);
      const md = stripLeadingDuplicateHeading(htmlToMarkdown(html), title);
      const outRel = path.posix.join(outVersionRel, "auxiliary", `${base}.md`);
      await writeSymbolMarkdown("auxiliary", "auxiliary", base, outRel, `# ${title}\n\n${md}`, `auxiliary/${base}.html`);
      writeChunk({
        id: `${detectedVersion}/auxiliary/${base}`,
        version: detectedVersion,
        stage: "auxiliary",
        kind: "auxiliary",
        name: base,
        relMarkdownPath: outRel,
        text: `# ${title}\n\n${md}`,
      });
    }
  }

  if (runtimeObj && only.has("runtime")) {
    await writeIndex(
      "runtime",
      "classes",
      (runtimeObj.classes ?? []).map((c: any) => ({ name: c.name, description: c.description })),
    );
    await writeIndex(
      "runtime",
      "concepts",
      (runtimeObj.concepts ?? []).map((c: any) => ({ name: c.name, description: c.description })),
    );
    await writeIndex(
      "runtime",
      "events",
      (runtimeObj.events ?? []).map((e: any) => ({ name: e.name, description: e.description })),
    );
    await writeIndex(
      "runtime",
      "defines",
      (runtimeObj.defines ?? []).map((d: any) => ({ name: d.name, description: d.description })),
    );

    for (const c of runtimeObj.classes ?? []) {
      stats.counts.runtime.classes++;
      const outRel = resolverMap.get(`runtime:${c.name}`)!.relPath;

      let md = `# ${c.name}\n\n${c.description ?? ""}\n`;
      if (c.parent) md += `${mdSection("Parent")}\n- \`${c.parent}\`\n`;

      const attributes = (c.attributes ?? []).slice().sort((a: any, b: any) => (a.order ?? 0) - (b.order ?? 0));
      if (attributes.length) {
        md += mdSection("Attributes");
        for (const a of attributes) {
          const readType = a.read_type != null ? typeToString(a.read_type) : "unknown";
          const writeType = a.write_type != null ? typeToString(a.write_type) : "unknown";
          md += `\n### ${a.name}\n\n`;
          md += `- Read: \`${readType}\`\n`;
          md += `- Write: \`${writeType}\`\n`;
          md += `- Optional: \`${String(!!a.optional)}\`\n\n`;
          if (a.description) md += `${a.description}\n`;

          writeChunk({
            id: `${detectedVersion}/runtime/class/${c.name}#${a.name}`,
            version: detectedVersion,
            stage: "runtime",
            kind: "class_attribute",
            name: c.name,
            member: a.name,
            relMarkdownPath: outRel,
            anchor: a.name,
            text: `# ${c.name}.${a.name} (attribute)\n\n- Read: \`${readType}\`\n- Write: \`${writeType}\`\n- Optional: \`${String(!!a.optional)}\`\n\n${a.description ?? ""}\n`,
          });
        }
      }

      const methods = (c.methods ?? []).slice().sort((a: any, b: any) => (a.order ?? 0) - (b.order ?? 0));
      if (methods.length) {
        md += mdSection("Methods");
        for (const m of methods) {
          md += `\n### ${m.name}\n\n`;
          const sig = renderSignature(`${c.name}.${m.name}`, m.parameters, m.return_values);
          md += `\n\`\`\`lua\n${sig}\n\`\`\`\n\n`;
          if (m.description) md += `${m.description}\n\n`;

          const params = (m.parameters ?? []).slice().sort((a: any, b: any) => (a.order ?? 0) - (b.order ?? 0));
          if (params.length) md += `${mdSection("Parameters")}\n${mdFieldList(params.map((p: any) => ({ name: p.name, optional: p.optional, type: typeToString(p.type), description: p.description })))}\n`;
          const rvs = (m.return_values ?? []).slice().sort((a: any, b: any) => (a.order ?? 0) - (b.order ?? 0));
          if (rvs.length) {
            md += `${mdSection("Returns")}\n`;
            md += rvs
              .map((r: any) => `- \`${typeToString(r.type)}${r.optional ? "?" : ""}\`${r.description ? ` — ${r.description}` : ""}`)
              .join("\n");
            md += "\n";
          }

          writeChunk({
            id: `${detectedVersion}/runtime/class/${c.name}#${m.name}`,
            version: detectedVersion,
            stage: "runtime",
            kind: "class_method",
            name: c.name,
            member: m.name,
            relMarkdownPath: outRel,
            anchor: m.name,
            text: `# ${c.name}.${m.name} (method)\n\n\`\`\`lua\n${sig}\n\`\`\`\n\n${m.description ?? ""}\n`,
          });
        }
      }

      await writeSymbolMarkdown("runtime", "class", c.name, outRel, md, "runtime-api.json");
      writeChunk({
        id: `${detectedVersion}/runtime/class/${c.name}`,
        version: detectedVersion,
        stage: "runtime",
        kind: "class",
        name: c.name,
        relMarkdownPath: outRel,
        text: `# ${c.name}\n\n${c.description ?? ""}\n`,
      });
    }

    for (const concept of runtimeObj.concepts ?? []) {
      stats.counts.runtime.concepts++;
      const outRel = resolverMap.get(`runtime:${concept.name}`)!.relPath;
      let md = `# ${concept.name}\n\n${concept.description ?? ""}\n`;
      if (concept.type) md += `${mdSection("Type")}\n\`${typeToString(concept.type)}\`\n`;
      await writeSymbolMarkdown("runtime", "concept", concept.name, outRel, md, "runtime-api.json");
      writeChunk({
        id: `${detectedVersion}/runtime/concept/${concept.name}`,
        version: detectedVersion,
        stage: "runtime",
        kind: "concept",
        name: concept.name,
        relMarkdownPath: outRel,
        text: md,
      });
    }

    for (const event of runtimeObj.events ?? []) {
      stats.counts.runtime.events++;
      const outRel = resolverMap.get(`runtime:${event.name}`)!.relPath;
      let md = `# ${event.name}\n\n${event.description ?? ""}\n`;
      const data = (event.data ?? []).slice().sort((a: any, b: any) => (a.order ?? 0) - (b.order ?? 0));
      if (data.length) {
        md += mdSection("Event Data");
        md += `${mdFieldList(data.map((d: any) => ({ name: d.name, optional: d.optional, type: typeToString(d.type), description: d.description })))}\n`;
      }
      const examples = event.examples ?? [];
      if (examples.length) {
        md += mdSection("Examples");
        md += examples.join("\n\n") + "\n";
      }
      await writeSymbolMarkdown("runtime", "event", event.name, outRel, md, "runtime-api.json");
      writeChunk({
        id: `${detectedVersion}/runtime/event/${event.name}`,
        version: detectedVersion,
        stage: "runtime",
        kind: "event",
        name: event.name,
        relMarkdownPath: outRel,
        text: md,
      });
    }

    for (const def of runtimeObj.defines ?? []) {
      stats.counts.runtime.defines++;
      const outRel = resolverMap.get(`runtime:defines.${def.name}`)!.relPath;
      let md = `# defines.${def.name}\n\n${def.description ?? ""}\n`;
      const values = (def.values ?? []).slice().sort((a: any, b: any) => (a.order ?? 0) - (b.order ?? 0));
      if (values.length) {
        md += mdSection("Values");
        for (const v of values) {
          md += `\n### ${v.name}\n\n${v.description ?? ""}\n`;
          writeChunk({
            id: `${detectedVersion}/runtime/define/${def.name}#${v.name}`,
            version: detectedVersion,
            stage: "runtime",
            kind: "define_value",
            name: `defines.${def.name}`,
            member: v.name,
            relMarkdownPath: outRel,
            anchor: v.name,
            text: `# defines.${def.name}.${v.name}\n\n${v.description ?? ""}\n`,
          });
        }
      }
      await writeSymbolMarkdown("runtime", "define", def.name, outRel, md, "runtime-api.json");
      writeChunk({
        id: `${detectedVersion}/runtime/define/${def.name}`,
        version: detectedVersion,
        stage: "runtime",
        kind: "define",
        name: `defines.${def.name}`,
        relMarkdownPath: outRel,
        text: md,
      });
    }

    for (const f of runtimeObj.global_functions ?? []) {
      stats.counts.runtime.global_functions++;
      const outRel = resolverMap.get(`runtime:${f.name}`)!.relPath;
      const sig = renderSignature(f.name, f.parameters, f.return_values);
      let md = `# ${f.name}\n\n${f.description ?? ""}\n\n\`\`\`lua\n${sig}\n\`\`\`\n`;
      const params = (f.parameters ?? []).slice().sort((a: any, b: any) => (a.order ?? 0) - (b.order ?? 0));
      if (params.length) md += `${mdSection("Parameters")}\n${mdFieldList(params.map((p: any) => ({ name: p.name, optional: p.optional, type: typeToString(p.type), description: p.description })))}\n`;
      const rvs = (f.return_values ?? []).slice().sort((a: any, b: any) => (a.order ?? 0) - (b.order ?? 0));
      if (rvs.length) {
        md += `${mdSection("Returns")}\n`;
        md += rvs
          .map((r: any) => `- \`${typeToString(r.type)}${r.optional ? "?" : ""}\`${r.description ? ` — ${r.description}` : ""}`)
          .join("\n");
        md += "\n";
      }
      await writeSymbolMarkdown("runtime", "global_function", f.name, outRel, md, "runtime-api.json");
      writeChunk({
        id: `${detectedVersion}/runtime/global_function/${f.name}`,
        version: detectedVersion,
        stage: "runtime",
        kind: "global_function",
        name: f.name,
        relMarkdownPath: outRel,
        text: md,
      });
    }

    for (const o of runtimeObj.global_objects ?? []) {
      stats.counts.runtime.global_objects++;
      const outRel = resolverMap.get(`runtime:${o.name}`)!.relPath;
      const typeStr = typeToString(o.type);
      const md = `# ${o.name}\n\nType: \`${typeStr}\`\n\n${o.description ?? ""}\n`;
      await writeSymbolMarkdown("runtime", "global_object", o.name, outRel, md, "runtime-api.json");
      writeChunk({
        id: `${detectedVersion}/runtime/global_object/${o.name}`,
        version: detectedVersion,
        stage: "runtime",
        kind: "global_object",
        name: o.name,
        relMarkdownPath: outRel,
        text: md,
      });
    }
  }

  if (prototypeObj && only.has("prototype")) {
    await writeIndex(
      "prototype",
      "prototypes",
      (prototypeObj.prototypes ?? []).map((p: any) => ({ name: p.name, description: p.description })),
    );
    await writeIndex(
      "prototype",
      "types",
      (prototypeObj.types ?? []).map((t: any) => ({ name: t.name, description: t.description })),
    );
    await writeIndex(
      "prototype",
      "defines",
      (prototypeObj.defines ?? []).map((d: any) => ({ name: d.name, description: d.description })),
    );

    for (const p of prototypeObj.prototypes ?? []) {
      stats.counts.prototype.prototypes++;
      const outRel = resolverMap.get(`prototype:${p.name}`)!.relPath;
      let md = `# ${p.name}\n\n${p.description ?? ""}\n`;
      if (p.parent) md += `${mdSection("Parent")}\n- \`${p.parent}\`\n`;

      const props = (p.properties ?? []).slice().sort((a: any, b: any) => (a.order ?? 0) - (b.order ?? 0));
      if (props.length) {
        md += mdSection("Properties");
        for (const prop of props) {
          md += `\n### ${prop.name}\n\n`;
          md += `- Type: \`${typeToString(prop.type)}\`\n`;
          md += `- Optional: \`${String(!!prop.optional)}\`\n`;
          md += `- Override: \`${String(!!prop.override)}\`\n\n`;
          if (prop.description) md += `${prop.description}\n\n`;
          if (prop.examples?.length) {
            md += `${mdSection("Examples")}\n${prop.examples.join("\n\n")}\n`;
          }

          writeChunk({
            id: `${detectedVersion}/prototype/prototype/${p.name}#${prop.name}`,
            version: detectedVersion,
            stage: "prototype",
            kind: "prototype_property",
            name: p.name,
            member: prop.name,
            relMarkdownPath: outRel,
            anchor: prop.name,
            text: `# ${p.name}.${prop.name} (property)\n\n- Type: \`${typeToString(prop.type)}\`\n- Optional: \`${String(!!prop.optional)}\`\n\n${prop.description ?? ""}\n`,
          });
        }
      }

      await writeSymbolMarkdown("prototype", "prototype", p.name, outRel, md, "prototype-api.json");
      writeChunk({
        id: `${detectedVersion}/prototype/prototype/${p.name}`,
        version: detectedVersion,
        stage: "prototype",
        kind: "prototype",
        name: p.name,
        relMarkdownPath: outRel,
        text: `# ${p.name}\n\n${p.description ?? ""}\n`,
      });
    }

    for (const t of prototypeObj.types ?? []) {
      stats.counts.prototype.types++;
      const outRel = resolverMap.get(`prototype:${t.name}`)!.relPath;
      let md = `# ${t.name}\n\n${t.description ?? ""}\n`;
      if (t.type) md += `${mdSection("Type")}\n\`${typeToString(t.type)}\`\n`;

      const props = (t.properties ?? []).slice().sort((a: any, b: any) => (a.order ?? 0) - (b.order ?? 0));
      if (props.length) {
        md += mdSection("Properties");
        for (const prop of props) {
          md += `\n### ${prop.name}\n\n`;
          md += `- Type: \`${typeToString(prop.type)}\`\n`;
          md += `- Optional: \`${String(!!prop.optional)}\`\n\n`;
          if (prop.description) md += `${prop.description}\n\n`;
          if (prop.examples?.length) md += `${mdSection("Examples")}\n${prop.examples.join("\n\n")}\n`;

          writeChunk({
            id: `${detectedVersion}/prototype/type/${t.name}#${prop.name}`,
            version: detectedVersion,
            stage: "prototype",
            kind: "type_property",
            name: t.name,
            member: prop.name,
            relMarkdownPath: outRel,
            anchor: prop.name,
            text: `# ${t.name}.${prop.name} (property)\n\n- Type: \`${typeToString(prop.type)}\`\n- Optional: \`${String(!!prop.optional)}\`\n\n${prop.description ?? ""}\n`,
          });
        }
      }

      await writeSymbolMarkdown("prototype", "type", t.name, outRel, md, "prototype-api.json");
      writeChunk({
        id: `${detectedVersion}/prototype/type/${t.name}`,
        version: detectedVersion,
        stage: "prototype",
        kind: "type",
        name: t.name,
        relMarkdownPath: outRel,
        text: md,
      });
    }

    for (const def of prototypeObj.defines ?? []) {
      stats.counts.prototype.defines++;
      const outRel = resolverMap.get(`prototype:defines.${def.name}`)!.relPath;
      let md = `# defines.${def.name}\n\n${def.description ?? ""}\n`;
      const values = (def.values ?? []).slice().sort((a: any, b: any) => (a.order ?? 0) - (b.order ?? 0));
      if (values.length) {
        md += mdSection("Values");
        for (const v of values) {
          md += `\n### ${v.name}\n\n${v.description ?? ""}\n`;
          writeChunk({
            id: `${detectedVersion}/prototype/define/${def.name}#${v.name}`,
            version: detectedVersion,
            stage: "prototype",
            kind: "define_value",
            name: `defines.${def.name}`,
            member: v.name,
            relMarkdownPath: outRel,
            anchor: v.name,
            text: `# defines.${def.name}.${v.name}\n\n${v.description ?? ""}\n`,
          });
        }
      }
      await writeSymbolMarkdown("prototype", "define", def.name, outRel, md, "prototype-api.json");
      writeChunk({
        id: `${detectedVersion}/prototype/define/${def.name}`,
        version: detectedVersion,
        stage: "prototype",
        kind: "define",
        name: `defines.${def.name}`,
        relMarkdownPath: outRel,
        text: md,
      });
    }
  }

  await new Promise<void>((resolveDone, reject) => {
    chunksStream.end((err) => {
      if (err) reject(err);
      else resolveDone();
    });
  });

  // Make the export self-contained for auxiliary references.
  if (runtimeJsonText) {
    await writeFile(
      path.join(outVersionAbs, "runtime-api.json"),
      runtimeJsonText.endsWith("\n") ? runtimeJsonText : runtimeJsonText + "\n",
      "utf8",
    );
  }
  if (prototypeJsonText) {
    await writeFile(
      path.join(outVersionAbs, "prototype-api.json"),
      prototypeJsonText.endsWith("\n") ? prototypeJsonText : prototypeJsonText + "\n",
      "utf8",
    );
  }

  const versionReadme = `# Factorio API Docs (LLM Export) — ${detectedVersion}

- Runtime: \`runtime/\` (control stage)
  - Classes: \`runtime/classes/index.md\`
  - Events: \`runtime/events/index.md\`
  - Concepts: \`runtime/concepts/index.md\`
  - Defines: \`runtime/defines/index.md\`
- Prototype: \`prototype/\` (data stage)
  - Prototypes: \`prototype/prototypes/index.md\`
  - Types: \`prototype/types/index.md\`
  - Defines: \`prototype/defines/index.md\`
- Auxiliary: \`auxiliary/\`
  - Data Lifecycle: \`auxiliary/data-lifecycle.md\`
  - Mod Structure: \`auxiliary/mod-structure.md\`
  - Migrations: \`auxiliary/migrations.md\`
- Start Here: \`SEARCH.md\`

Machine-readable sources:

- \`runtime-api.json\`
- \`prototype-api.json\`
- \`chunks.jsonl\` (chunked text + metadata)
`;
  await writeFile(path.join(outVersionAbs, "README.md"), versionReadme, "utf8");

  const searchDoc = `# Search Guide — ${detectedVersion}

Use this page as a “jump list” when working with Codex or any RAG indexer.

## Start Here

- Runtime overview: [Runtime Classes](runtime/classes/index.md), [Runtime Events](runtime/events/index.md), [Runtime Concepts](runtime/concepts/index.md), [Runtime Defines](runtime/defines/index.md)
- Prototype overview: [Prototype Prototypes](prototype/prototypes/index.md), [Prototype Types](prototype/types/index.md), [Prototype Defines](prototype/defines/index.md)
- Core mod docs: [Data Lifecycle](auxiliary/data-lifecycle.md), [Mod Structure](auxiliary/mod-structure.md), [Storage](auxiliary/storage.md), [Migrations](auxiliary/migrations.md)

## Tiles (stone paths, etc.)

- Get/inspect tiles (runtime): [LuaSurface](runtime/classes/LuaSurface.md), [LuaTile](runtime/classes/LuaTile.md), [LuaTilePrototype](runtime/classes/LuaTilePrototype.md)
- Place/replace tiles: [LuaSurface.set_tiles](runtime/classes/LuaSurface.md#set_tiles), [Tile](runtime/concepts/Tile.md), [TilePosition](runtime/concepts/TilePosition.md)
- Mine tiles: [LuaControl.mine_tile](runtime/classes/LuaControl.md#mine_tile)
- Tile prototypes (data stage): [TilePrototype](prototype/prototypes/TilePrototype.md)
- Find a tile name (vanilla or modded): [LuaPrototypes.tile](runtime/classes/LuaPrototypes.md#tile), [LuaPrototypes.get_tile_filtered](runtime/classes/LuaPrototypes.md#get_tile_filtered)

## Entities & Prototypes

- Runtime entity API: [LuaEntity](runtime/classes/LuaEntity.md), [LuaEntityPrototype](runtime/classes/LuaEntityPrototype.md)
- Enumerate prototypes by name: [LuaPrototypes](runtime/classes/LuaPrototypes.md)
- Data-stage entity definition: [EntityPrototype](prototype/prototypes/EntityPrototype.md)

## Events & Script Hooks

- Browse events: [Runtime Events](runtime/events/index.md)
- Register handlers: [LuaBootstrap.on_event](runtime/classes/LuaBootstrap.md#on_event), [LuaBootstrap.on_nth_tick](runtime/classes/LuaBootstrap.md#on_nth_tick)
- Custom inputs: [CustomInputPrototype](prototype/prototypes/CustomInputPrototype.md), [CustomInputEvent](runtime/events/CustomInputEvent.md)

## Players, Surfaces, Forces

- Player API: [LuaPlayer](runtime/classes/LuaPlayer.md), [LuaControl](runtime/classes/LuaControl.md)
- Surface API: [LuaSurface](runtime/classes/LuaSurface.md)
- Force API: [LuaForce](runtime/classes/LuaForce.md)

## GUI & Rendering

- GUI root: [LuaGui](runtime/classes/LuaGui.md), [LuaGuiElement](runtime/classes/LuaGuiElement.md), [LuaStyle](runtime/classes/LuaStyle.md)
- Rendering API: [LuaRendering](runtime/classes/LuaRendering.md)

## Remote, Commands, Logging

- Remote interfaces: [LuaRemote](runtime/classes/LuaRemote.md)
- Custom commands: [LuaCommandProcessor](runtime/classes/LuaCommandProcessor.md)
- Logging/utilities: [Libraries](auxiliary/libraries.md)

## Quick grep ideas

- Search the corpus: \`rg -n \"<term>\" llm-docs/${detectedVersion} -S\`
- Search only chunk text: \`rg -n \"<term>\" llm-docs/${detectedVersion}/chunks.jsonl -S\`
`;
  await writeFile(path.join(outVersionAbs, "SEARCH.md"), searchDoc, "utf8");

  await writeFile(path.join(outVersionAbs, "manifest.json"), JSON.stringify(stats, null, 2) + "\n", "utf8");
  console.log(`Wrote:\n- ${outVersionAbs}\n- ${chunksPathAbs}`);
}

main().catch((err) => {
  console.error(err?.stack ?? String(err));
  process.exit(1);
});
