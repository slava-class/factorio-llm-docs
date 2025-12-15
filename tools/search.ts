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
  bun tools/search.ts <command> [args] [--version <x.y.z>] [--root <dir>]

Commands:
  search <query>        Search chunks.jsonl
  get <id>              Fetch one chunk by id (not implemented yet)
  open <id|relPath>     Print markdown for a chunk/page (not implemented yet)
  versions              List versions under llm-docs/

Options:
  --version <x.y.z>     Version under llm-docs/ (default: latest present)
  --root <dir>          Docs root (default: ./llm-docs)
  --limit <n>           search: max hits (default: 10)
  --stage <stages>      search: comma-separated (runtime,prototype,auxiliary)
  --kind <kinds>        search: comma-separated (class_method,event,...)
  --name <names>        search: comma-separated (LuaEntity,EntityPrototype,...)
  --member <members>    search: comma-separated (clone,set_tiles,...)
  -h, --help            Show help
`);
}

function parseArgs(argv: string[]) {
  const flags = new Map<string, string | boolean>();
  const positionals: string[] = [];

  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--help" || a === "-h") {
      flags.set("help", true);
      continue;
    }
    if (a.startsWith("--")) {
      const key = a.slice(2);
      const next = argv[i + 1];
      if (next != null && !next.startsWith("-")) {
        flags.set(key, next);
        i++;
      } else {
        flags.set(key, true);
      }
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

  if (command === "versions") {
    const versions = await listVersions(root);
    if (!versions.length) throw new Error(`No versions found under: ${root}`);
    for (const v of versions) console.log(v);
    return;
  }

  const versions = await listVersions(root);
  if (!versions.length) throw new Error(`No versions found under: ${root}`);
  const latest = versions[versions.length - 1]!;

  const versionFlag = flags.get("version");
  const selectedVersion = typeof versionFlag === "string" ? versionFlag : latest;
  const versionDir = await resolveVersionDir(root, selectedVersion);

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

  switch (command) {
    case "search": {
      const query = positionals.join(" ").trim();
      if (!query) throw new Error("Usage: search <query>");

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
      if (target.includes("/") || target.endsWith(".md")) {
        const abs = resolveMarkdownPathFromRelPath(target);
        console.log(await readFile(abs, "utf8"));
        return;
      }
      if (symbols && target in symbols) {
        const entry = (symbols as any)[target] as { relPath: string };
        const abs = resolveMarkdownPathFromRelPath(entry.relPath);
        console.log(await readFile(abs, "utf8"));
        return;
      }
      throw new Error(`Not implemented: open by id (${target})`);
      void target;
      throw new Error("Not implemented: open");
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
