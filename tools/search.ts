#!/usr/bin/env bun
import { createReadStream, existsSync } from "node:fs";
import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import readline from "node:readline";
import { Either, Schema } from "effect";
import { ChunkRecordSchema, SymbolsSchema, decodeJsonOrThrow } from "./effect-json";

type Command = "search" | "get" | "open" | "versions";

function printHelp() {
  console.log(`factorio-llm-docs search CLI

Usage:
  bun tools/search.ts <command> [args] [--version <x.y.z>] [--root <dir>] [--]

Commands:
  search <query>        Search chunks.jsonl
  get <id>              Fetch one chunk by id (JSON)
  open <id|relPath>     Print markdown for a chunk/page (chunk id or relPath[#anchor]; also supports symbols.json keys)
  versions              List versions under llm-docs/

Options:
  --version <x.y.z>     Version under llm-docs/ (default: latest present)
  --root <dir>          Docs root (default: ./llm-docs)
  --json                search/versions: emit machine-readable JSON
  --limit <n>           search: max hits (default: 10)
  --stage <stages>      search: comma-separated (runtime,prototype,auxiliary)
  --kind <kinds>        search: comma-separated (class_method,event,...)
  --name <names>        search: comma-separated (LuaEntity,EntityPrototype,...)
  --member <members>    search: comma-separated (clone,set_tiles,...)
  --open                search: open the top hit (prints markdown/text instead of the hit list)
  --print-ids           search: print only chunk ids (one per line)
  --quiet               Suppress non-essential stderr output
  --                    End of flags (treat remaining args as positional)
  -h, --help            Show help
`);
}

function parseArgs(argv: string[]) {
  const flags = new Map<string, string | boolean>();
  const positionals: string[] = [];

  const valueFlags = new Set(["version", "root", "limit", "stage", "kind", "name", "member"]);

  let endOfFlags = false;
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--") {
      endOfFlags = true;
      continue;
    }
    if (a === "--help" || a === "-h") {
      flags.set("help", true);
      continue;
    }
    if (!endOfFlags && a.startsWith("--")) {
      const key = a.slice(2);
      const next = argv[i + 1];
      if (valueFlags.has(key)) {
        if (next == null) throw new Error(`Missing value for --${key}`);
        flags.set(key, next);
        i++;
        continue;
      }
      flags.set(key, true);
      continue;
    }
    positionals.push(a);
  }

  const cmd = positionals.shift();
  return { cmd, positionals, flags };
}

function resolveDocsRoot(cwd: string, flagValue: string | undefined) {
  const root = flagValue ? path.resolve(cwd, flagValue) : path.resolve(cwd, "llm-docs");
  if (!existsSync(root)) throw new Error(`Docs root not found: ${root}`);
  return root;
}

function parseCsvFlag(value: string | undefined) {
  return (value ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
}

function normalizeFilterValue(value: string) {
  return value.trim().toLowerCase();
}

function compareVersions(a: string, b: string) {
  const pa = a.split(".").map((p) => Number(p));
  const pb = b.split(".").map((p) => Number(p));
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const da = pa[i] ?? 0;
    const db = pb[i] ?? 0;
    if (da !== db) return da - db;
  }
  return 0;
}

async function listVersions(root: string) {
  const entries = await readdir(root, { withFileTypes: true });
  return entries
    .filter((e) => e.isDirectory() && /^\d+\.\d+\.\d+$/.test(e.name))
    .map((e) => e.name)
    .sort(compareVersions);
}

async function resolveVersionDir(root: string, version: string) {
  const dir = path.join(root, version);
  if (!existsSync(dir)) throw new Error(`Version not found under ${root}: ${version}`);
  return dir;
}

function countOccurrences(haystack: string, needle: string) {
  if (!needle) return 0;
  let count = 0;
  let i = 0;
  while (true) {
    const idx = haystack.indexOf(needle, i);
    if (idx === -1) return count;
    count++;
    i = idx + needle.length;
  }
}

function makeSnippet(text: string, idx: number, queryLen: number) {
  const clean = text.replace(/\s+/g, " ").trim();
  const i = Math.max(0, Math.min(idx, clean.length));
  const start = Math.max(0, i - 60);
  const end = Math.min(clean.length, i + queryLen + 120);
  const head = start > 0 ? "…" : "";
  const tail = end < clean.length ? "…" : "";
  return `${head}${clean.slice(start, end)}${tail}`;
}

type ChunkRecord = typeof ChunkRecordSchema.Type;

const decodeChunkEither = Schema.decodeUnknownEither(Schema.parseJson(ChunkRecordSchema));

async function* iterateChunks(chunksPath: string) {
  const rl = readline.createInterface({
    input: createReadStream(chunksPath, { encoding: "utf8" }),
    crlfDelay: Infinity,
  });

  try {
    for await (const line of rl) {
      if (!line) continue;
      const decoded = decodeChunkEither(line);
      if (Either.isRight(decoded)) yield decoded.right;
    }
  } finally {
    rl.close();
  }
}

async function findChunkById(chunksPath: string, id: string) {
  for await (const chunk of iterateChunks(chunksPath)) {
    if (chunk.id === id) return chunk;
  }
  return null;
}

function isJsonFlag(value: string | boolean | undefined) {
  return value === true || value === "true" || value === "1";
}

function isTruthyFlag(value: string | boolean | undefined) {
  return value === true || value === "true" || value === "1";
}

function looksLikeChunkId(s: string) {
  return /^\d+\.\d+\.\d+\/.+/.test(s);
}

function githubSlugBase(input: string) {
  return input
    .trim()
    .toLowerCase()
    .replace(/[`~!@#$%^&*()+={}\[\]|\\:;"'<>,.?/]/g, "")
    .replace(/\s+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "");
}

function extractMarkdownSectionByAnchor(markdown: string, anchor: string) {
  const lines = markdown.replace(/\r\n?/g, "\n").split("\n");
  const anchorTrimmed = anchor.trim();
  if (!anchorTrimmed) return null;

  let startIdx = -1;
  let startLevel = 0;
  const slugCounts = new Map<string, number>();

  for (let i = 0; i < lines.length; i++) {
    const m = /^(#{1,6})\s+(.+?)\s*$/.exec(lines[i] ?? "");
    if (!m) continue;
    const level = m[1]!.length;
    const heading = m[2]!.trim();

    const base = githubSlugBase(heading);
    const nextCount = (slugCounts.get(base) ?? 0) + 1;
    slugCounts.set(base, nextCount);
    const slug = base ? (nextCount === 1 ? base : `${base}-${nextCount - 1}`) : "";

    if (heading === anchorTrimmed || slug === anchorTrimmed) {
      startIdx = i;
      startLevel = level;
      break;
    }
  }

  if (startIdx === -1) return null;

  let endIdx = lines.length;
  for (let i = startIdx + 1; i < lines.length; i++) {
    const m = /^(#{1,6})\s+/.exec(lines[i] ?? "");
    if (!m) continue;
    const level = m[1]!.length;
    if (level <= startLevel) {
      endIdx = i;
      break;
    }
  }

  const out = lines.slice(startIdx, endIdx).join("\n").trimEnd();
  return out.length ? out + "\n" : null;
}

function writeStdout(text: string) {
  const out = text.endsWith("\n") ? text : text + "\n";
  process.stdout.write(out);
}

async function main() {
  const cwd = process.cwd();
  const { cmd, positionals, flags } = parseArgs(Bun.argv.slice(2));

  if (!cmd || flags.get("help")) {
    printHelp();
    return;
  }

  const command = cmd as Command;
  if (!["search", "get", "open", "versions"].includes(command)) {
    throw new Error(`Unknown command: ${cmd}`);
  }

  const root = resolveDocsRoot(cwd, flags.get("root") ? String(flags.get("root")) : undefined);
  const json = isJsonFlag(flags.get("json") as any);
  const quiet = isTruthyFlag(flags.get("quiet") as any);

  if (command === "versions") {
    const versions = await listVersions(root);
    if (!versions.length) throw new Error(`No versions found under: ${root}`);
    if (json) {
      console.log(JSON.stringify({ root, versions }, null, 2));
      return;
    }
    for (const v of versions) console.log(v);
    return;
  }

  const versions = await listVersions(root);
  if (!versions.length) throw new Error(`No versions found under: ${root}`);
  const latest = versions[versions.length - 1]!;

  const versionFlag = flags.get("version");
  const selectedVersion = typeof versionFlag === "string" ? versionFlag : latest;
  const versionDir = await resolveVersionDir(root, selectedVersion);

  if (!json && !quiet) {
    console.error(`Using version: ${selectedVersion}`);
  }

  const limitFlag = flags.get("limit");
  const limit = limitFlag == null ? 10 : Number(limitFlag);
  if (!Number.isFinite(limit) || limit <= 0) throw new Error(`Invalid --limit: ${String(limitFlag)}`);

  const stageSet = new Set(parseCsvFlag(flags.get("stage") as string | undefined).map(normalizeFilterValue));
  const kindSet = new Set(parseCsvFlag(flags.get("kind") as string | undefined).map(normalizeFilterValue));
  const nameSet = new Set(parseCsvFlag(flags.get("name") as string | undefined).map(normalizeFilterValue));
  const memberSet = new Set(parseCsvFlag(flags.get("member") as string | undefined).map(normalizeFilterValue));

  const hasStageFilter = stageSet.size > 0;
  const hasKindFilter = kindSet.size > 0;
  const hasNameFilter = nameSet.size > 0;
  const hasMemberFilter = memberSet.size > 0;

  const symbolsPath = path.join(versionDir, "symbols.json");
  const symbols = existsSync(symbolsPath)
    ? decodeJsonOrThrow(SymbolsSchema, await readFile(symbolsPath, "utf8"), "symbols.json")
    : null;

  function resolveMarkdownPathFromRelPath(relPath: string) {
    const abs = path.join(versionDir, relPath);
    if (!existsSync(abs)) throw new Error(`Markdown not found: ${abs}`);
    return abs;
  }

  function parseRelPathAndAnchor(s: string) {
    const hashIdx = s.indexOf("#");
    if (hashIdx === -1) return { relPath: s, anchor: undefined as string | undefined };
    const relPath = s.slice(0, hashIdx);
    const anchor = s.slice(hashIdx + 1);
    return { relPath, anchor: anchor || undefined };
  }

  switch (command) {
    case "search": {
      const query = positionals.join(" ").trim();
      if (!query) throw new Error("Usage: search <query>");

      const openTop = isTruthyFlag(flags.get("open") as any);
      if (openTop && json) {
        throw new Error("Cannot use --open with --json (open prints markdown/text).");
      }

      const printIds = isTruthyFlag(flags.get("print-ids") as any);
      if (printIds && json) {
        throw new Error("Cannot use --print-ids with --json (use --json and read hits[].id).");
      }
      if (printIds && openTop) {
        throw new Error("Cannot use --print-ids with --open.");
      }

      const chunksPath = path.join(versionDir, "chunks.jsonl");
      if (!existsSync(chunksPath)) throw new Error(`Missing chunks.jsonl: ${chunksPath}`);

      const q = query.toLowerCase();
      const hits: Array<{
        score: number;
        id: string;
        stage: string;
        kind: string;
        name: string;
        member?: string;
        relPath?: string;
        anchor?: string;
        snippet: string;
      }> = [];

      for await (const chunk of iterateChunks(chunksPath)) {
        const stageLower = chunk.stage.toLowerCase();
        if (hasStageFilter && !stageSet.has(stageLower)) continue;

        const kindLower = chunk.kind.toLowerCase();
        if (hasKindFilter && !kindSet.has(kindLower)) continue;

        const nameLower = chunk.name.toLowerCase();
        if (hasNameFilter && !nameSet.has(nameLower)) continue;

        const memberLower = chunk.member?.toLowerCase() ?? "";
        if (hasMemberFilter && !memberSet.has(memberLower)) continue;

        const idLower = chunk.id.toLowerCase();
        const textLower = chunk.text.toLowerCase();

        const idx = textLower.indexOf(q);
        const count = countOccurrences(textLower, q);

        let score = 0;
        if (idLower.includes(q)) score += 20;
        if (nameLower.includes(q)) score += 10;
        if (memberLower.includes(q)) score += 8;
        if (idx !== -1) score += Math.min(20, count) * 2;

        if (score <= 0) continue;

        const snippet = idx !== -1 ? makeSnippet(chunk.text, idx, q.length) : chunk.text.replace(/\s+/g, " ").slice(0, 140);
        hits.push({
          score,
          id: chunk.id,
          stage: chunk.stage,
          kind: chunk.kind,
          name: chunk.name,
          member: chunk.member,
          relPath: chunk.relPath,
          anchor: chunk.anchor,
          snippet,
        });

        hits.sort((a, b) => b.score - a.score || a.id.localeCompare(b.id));
        if (hits.length > limit) hits.length = limit;
      }

      if (!hits.length) return;

      if (openTop) {
        const top = hits[0]!;
        const chunk = await findChunkById(chunksPath, top.id);
        if (!chunk) throw new Error(`Chunk not found: ${top.id}`);

        if (!chunk.relPath) {
          writeStdout(chunk.text);
          return;
        }
        const abs = resolveMarkdownPathFromRelPath(chunk.relPath);
        const md = await readFile(abs, "utf8");
        const anchored = chunk.anchor ? extractMarkdownSectionByAnchor(md, chunk.anchor) : null;
        writeStdout(anchored ?? chunk.text ?? md);
        return;
      }

      if (printIds) {
        for (const h of hits) console.log(h.id);
        return;
      }

      if (json) {
        console.log(JSON.stringify({ root, version: selectedVersion, query, limit, hits }, null, 2));
        return;
      }

      for (const h of hits) {
        const loc = h.relPath ? `${h.relPath}${h.anchor ? `#${h.anchor}` : ""}` : "(no relPath)";
        console.log(`${h.score}\t${h.stage}\t${h.kind}\t${h.id}\t${loc}`);
        console.log(`  ${h.snippet}`);
      }
      return;
    }
    case "get": {
      const id = positionals[0]?.trim();
      if (!id) throw new Error("Usage: get <id>");
      const chunksPath = path.join(versionDir, "chunks.jsonl");
      if (!existsSync(chunksPath)) throw new Error(`Missing chunks.jsonl: ${chunksPath}`);

      const chunk = await findChunkById(chunksPath, id);
      if (!chunk) throw new Error(`Chunk not found: ${id}`);

      console.log(JSON.stringify(chunk, null, 2));
      return;
    }
    case "open": {
      const target = positionals[0]?.trim();
      if (!target) throw new Error("Usage: open <id|relPath>");
      if ((target.includes("/") || target.endsWith(".md") || target.includes("#")) && !looksLikeChunkId(target)) {
        const { relPath, anchor } = parseRelPathAndAnchor(target);
        const abs = resolveMarkdownPathFromRelPath(relPath);
        const md = await readFile(abs, "utf8");
        const anchored = anchor ? extractMarkdownSectionByAnchor(md, anchor) : null;
        writeStdout(anchored ?? md);
        return;
      }
      if (symbols && target in symbols) {
        const entry = (symbols as any)[target] as { relPath: string; anchor?: string };
        const abs = resolveMarkdownPathFromRelPath(entry.relPath);
        const md = await readFile(abs, "utf8");
        const anchored = entry.anchor ? extractMarkdownSectionByAnchor(md, entry.anchor) : null;
        writeStdout(anchored ?? md);
        return;
      }

      const chunksPath = path.join(versionDir, "chunks.jsonl");
      if (!existsSync(chunksPath)) throw new Error(`Missing chunks.jsonl: ${chunksPath}`);

      const chunk = await findChunkById(chunksPath, target);
      if (!chunk) throw new Error(`Chunk not found: ${target}`);

      if (!chunk.relPath) {
        writeStdout(chunk.text);
        return;
      }

      const abs = resolveMarkdownPathFromRelPath(chunk.relPath);
      const md = await readFile(abs, "utf8");
      const anchored = chunk.anchor ? extractMarkdownSectionByAnchor(md, chunk.anchor) : null;
      writeStdout(anchored ?? chunk.text ?? md);
      return;
    }
    default: {
      const _exhaustive: never = command;
      void _exhaustive;
    }
  }
}

await main().catch((err) => {
  console.error(err instanceof Error ? err.message : String(err));
  process.exitCode = 1;
});
