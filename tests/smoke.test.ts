import { test, expect } from "bun:test";
import { createReadStream, existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import path from "node:path";
import readline from "node:readline";
import { ChunkRecordSchema, ManifestSchema, SymbolsSchema, decodeJsonOrThrow } from "../tools/effect-json";

const repoRoot = path.resolve(import.meta.dir, "..");
const version = process.env.FACTORIO_SMOKE_VERSION ?? "2.0.72";
const cachedInputDir = path.join(repoRoot, ".work", "factorio-api-input", version);

function requireCachedInputs() {
  const runtimeJson = path.join(cachedInputDir, "runtime-api.json");
  if (!existsSync(runtimeJson)) {
    throw new Error(
      `Missing cached inputs at ${cachedInputDir}\nRun: mise run setup-smoke-input -- ${version}`,
    );
  }
}

test("smoke: generator runs against cached Factorio inputs", async () => {
  requireCachedInputs();

  const outDirName = ".smoke-out";
  const outVersionDir = path.join(cachedInputDir, outDirName, version);

  const proc = Bun.spawn(
    [
      "bun",
      path.join(repoRoot, "tools", "factorio-api-docs-to-llm.ts"),
      "--force",
      "--out",
      outDirName,
      "--version",
      version,
      "--only",
      "runtime,prototype,auxiliary",
    ],
    { cwd: cachedInputDir, stdout: "pipe", stderr: "pipe" },
  );

  const [stdout, stderr, code] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);

  expect(code, `stdout:\n${stdout}\n\nstderr:\n${stderr}`).toBe(0);

  const manifestPath = path.join(outVersionDir, "manifest.json");
  const manifest = decodeJsonOrThrow(ManifestSchema, await readFile(manifestPath, "utf8"), "manifest.json") as any;
  delete manifest.generated_at;
  expect(manifest).toMatchSnapshot();

  const readme = await readFile(path.join(outVersionDir, "README.md"), "utf8");
  expect(readme).toContain(version);
  expect(readme).toMatchSnapshot();

  const symbols = decodeJsonOrThrow(SymbolsSchema, await readFile(path.join(outVersionDir, "symbols.json"), "utf8"), "symbols.json") as any;
  expect(symbols["runtime:class:LuaEntity"]).toEqual({
    id: `${version}/runtime/class/LuaEntity`,
    stage: "runtime",
    kind: "class",
    name: "LuaEntity",
    relPath: "runtime/classes/LuaEntity.md",
  });

  const search = await readFile(path.join(outVersionDir, "SEARCH.md"), "utf8");
  expect(search.split("\n").slice(0, 40).join("\n")).toMatchSnapshot();

  const luaEntity = await readFile(path.join(outVersionDir, "runtime", "classes", "LuaEntity.md"), "utf8");
  expect(luaEntity.split("\n").slice(0, 60).join("\n")).toMatchSnapshot();

  const entityPrototype = await readFile(
    path.join(outVersionDir, "prototype", "prototypes", "EntityPrototype.md"),
    "utf8",
  );
  expect(entityPrototype.split("\n").slice(0, 60).join("\n")).toMatchSnapshot();

  const chunksStat = await Bun.file(path.join(outVersionDir, "chunks.jsonl")).stat();
  expect(chunksStat.size).toBeGreaterThan(10_000);

  const chunksPath = path.join(outVersionDir, "chunks.jsonl");
  const rl = readline.createInterface({
    input: createReadStream(chunksPath, { encoding: "utf8" }),
    crlfDelay: Infinity,
  });

  let luaEntityChunk: any | undefined;
  for await (const line of rl) {
    if (!line) continue;
    if (!line.includes(`"stage":"runtime"`)) continue;
    if (!line.includes(`"kind":"class"`)) continue;
    if (!line.includes(`"name":"LuaEntity"`)) continue;
    luaEntityChunk = decodeJsonOrThrow(ChunkRecordSchema, line, "chunks.jsonl line") as any;
    break;
  }
  rl.close();
  expect(luaEntityChunk, "Expected a runtime class chunk for LuaEntity").toBeTruthy();
  expect(luaEntityChunk.relPath).toBe("runtime/classes/LuaEntity.md");
});
