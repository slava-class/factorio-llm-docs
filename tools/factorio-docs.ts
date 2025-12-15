#!/usr/bin/env bun
import { mkdir, readdir, rm, writeFile } from "node:fs/promises";
import path from "node:path";

const BASE = "https://lua-api.factorio.com";

type Channel = "stable" | "latest";

type VersionsReport = {
  stable?: string;
  latest?: string;
  last5: string[];
  all: string[];
};

function parseArgs(argv: string[]) {
  const [cmd, ...rest] = argv;
  const flags = new Map<string, string | boolean>();
  const positionals: string[] = [];

  for (let i = 0; i < rest.length; i++) {
    const a = rest[i];
    if (a.startsWith("--")) {
      const key = a.slice(2);
      const next = rest[i + 1];
      if (next != null && !next.startsWith("--")) {
        flags.set(key, next);
        i++;
      } else {
        flags.set(key, true);
      }
      continue;
    }
    positionals.push(a);
  }

  return { cmd, flags, positionals };
}

function isVersion(s: string) {
  return /^\d+\.\d+\.\d+$/.test(s);
}

function cmpSemverDesc(a: string, b: string) {
  const pa = a.split(".").map(Number);
  const pb = b.split(".").map(Number);
  for (let i = 0; i < 3; i++) {
    const d = (pb[i] ?? 0) - (pa[i] ?? 0);
    if (d !== 0) return d;
  }
  return 0;
}

async function fetchText(url: string) {
  const res = await fetch(url, { redirect: "follow" });
  if (!res.ok) throw new Error(`Fetch failed ${res.status} ${res.statusText} for ${url}`);
  return await res.text();
}

function parseVersionFromHtml(html: string): string | null {
  const m1 = html.match(/Version<\/span>\s*([0-9]+\.[0-9]+\.[0-9]+)/i);
  if (m1) return m1[1];
  const m2 = html.match(/\bVersion\b\s*([0-9]+\.[0-9]+\.[0-9]+)/i);
  if (m2) return m2[1];
  return null;
}

async function resolveChannel(channel: Channel): Promise<string> {
  const html = await fetchText(`${BASE}/${channel}/`);
  const v = parseVersionFromHtml(html);
  if (!v) throw new Error(`Could not parse version from ${BASE}/${channel}/`);
  return v;
}

function parseAllVersionsFromIndex(html: string): string[] {
  const matches = [...html.matchAll(/href=["'](?:https?:\/\/lua-api\.factorio\.com\/)?\/?(\d+\.\d+\.\d+)\/?["']/g)].map((m) => m[1]);
  const uniq = Array.from(new Set(matches)).filter(isVersion);
  uniq.sort(cmpSemverDesc);
  return uniq;
}

async function getVersions(): Promise<VersionsReport> {
  const [stable, latest] = await Promise.all([
    resolveChannel("stable").catch(() => undefined),
    resolveChannel("latest").catch(() => undefined),
  ]);

  const indexHtml = await fetchText(`${BASE}/`);
  const all = parseAllVersionsFromIndex(indexHtml);
  const last5 = all.slice(0, 5);

  return { stable, latest, last5, all };
}

async function downloadArchiveZip(version: string, outZipPath: string) {
  const url = `${BASE}/${version}/static/archive.zip`;
  const res = await fetch(url, { redirect: "follow" });
  if (!res.ok) throw new Error(`Download failed ${res.status} ${res.statusText} for ${url}`);
  await writeFile(outZipPath, Buffer.from(await res.arrayBuffer()));
}

async function findDocsRoot(extractedDir: string): Promise<string> {
  async function walk(dir: string, depth: number): Promise<string | null> {
    if (depth < 0) return null;
    const entries = await readdir(dir, { withFileTypes: true });
    for (const e of entries) {
      if (e.isFile() && e.name === "runtime-api.json") return dir;
    }
    for (const e of entries) {
      if (!e.isDirectory()) continue;
      const found = await walk(path.join(dir, e.name), depth - 1);
      if (found) return found;
    }
    return null;
  }

  const found = await walk(extractedDir, 5);
  if (!found) throw new Error(`Could not find runtime-api.json under ${extractedDir}`);
  return found;
}

async function runGenerator(docsRoot: string, repoRoot: string, version: string) {
  const outDirAbs = path.join(repoRoot, "llm-docs");
  const outDirFromDocsRoot = path.relative(docsRoot, outDirAbs) || ".";
  const generator = path.join(repoRoot, "tools", "factorio-api-docs-to-llm.ts");

  const proc = Bun.spawn(
    [
      "bun",
      generator,
      "--force",
      "--out",
      outDirFromDocsRoot,
      "--version",
      version,
    ],
    {
      cwd: docsRoot,
      stdout: "inherit",
      stderr: "inherit",
    },
  );
  const code = await proc.exited;
  if (code !== 0) throw new Error(`Generator failed with exit code ${code}`);
}

async function generateForVersion(version: string) {
  const repoRoot = path.resolve(import.meta.dir, "..");

  const workBase = path.join(repoRoot, ".work", "factorio-api", version);
  const zipPath = path.join(workBase, "archive.zip");
  const extractDir = path.join(workBase, "extracted");

  await rm(workBase, { recursive: true, force: true });
  await mkdir(extractDir, { recursive: true });

  try {
    await downloadArchiveZip(version, zipPath);

    const unzip = Bun.spawn(["unzip", "-q", zipPath, "-d", extractDir], {
      stdout: "inherit",
      stderr: "inherit",
    });
    const unzipCode = await unzip.exited;
    if (unzipCode !== 0) throw new Error(`unzip failed with exit code ${unzipCode}`);

    const docsRoot = await findDocsRoot(extractDir);
    await runGenerator(docsRoot, repoRoot, version);
  } finally {
    await rm(workBase, { recursive: true, force: true });
  }
}

async function cmdVersions() {
  const report = await getVersions();
  console.log(JSON.stringify(report, null, 2));
}

async function cmdGenerate(target: string) {
  if (isVersion(target)) {
    await generateForVersion(target);
    return;
  }

  if (target === "stable" || target === "latest") {
    const version = await resolveChannel(target);
    await generateForVersion(version);
    return;
  }

  throw new Error(`Unknown target: ${target} (expected stable|latest|x.y.z)`);
}

async function cmdGenerateLast5(channel: Channel) {
  const report = await getVersions();
  const base = channel === "stable" ? report.stable : report.latest;

  if (!base) {
    console.warn(`Skipping ${channel}: could not resolve channel version.`);
    return;
  }

  const set = new Set<string>();
  set.add(base);
  for (const v of report.last5) set.add(v);

  const list = Array.from(set).sort(cmpSemverDesc);
  for (const v of list) {
    console.log(`\n== Generating ${v} ==`);
    await generateForVersion(v);
  }
}

async function cmdGenerateAll() {
  const report = await getVersions();
  const set = new Set<string>();
  if (report.stable) set.add(report.stable);
  if (report.latest) set.add(report.latest);
  for (const v of report.last5) set.add(v);

  const list = Array.from(set).sort(cmpSemverDesc);
  console.log(`Will generate ${list.length} version(s): ${list.join(", ")}`);
  for (const v of list) {
    console.log(`\n== Generating ${v} ==`);
    await generateForVersion(v);
  }
}

async function main() {
  const { cmd, flags } = parseArgs(Bun.argv.slice(2));

  if (!cmd || cmd === "--help" || cmd === "help") {
    console.log(`factorio-docs\n\nCommands:\n  versions\n  generate --target <stable|latest|x.y.z>\n  generate-last5 --channel <stable|latest>\n  generate-all\n`);
    process.exit(0);
  }

  if (cmd === "versions") {
    await cmdVersions();
    return;
  }

  if (cmd === "generate") {
    const target = String(flags.get("target") ?? "latest");
    await cmdGenerate(target);
    return;
  }

  if (cmd === "generate-last5") {
    const channel = String(flags.get("channel") ?? "stable") as Channel;
    if (channel !== "stable" && channel !== "latest") {
      throw new Error(`Invalid --channel: ${channel}`);
    }
    await cmdGenerateLast5(channel);
    return;
  }

  if (cmd === "generate-all") {
    await cmdGenerateAll();
    return;
  }

  throw new Error(`Unknown command: ${cmd}`);
}

main().catch((err) => {
  console.error(err?.stack ?? String(err));
  process.exit(1);
});
