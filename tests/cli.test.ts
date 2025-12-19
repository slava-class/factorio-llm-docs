import { expect, test } from "bun:test";
import path from "node:path";

const repoRoot = path.resolve(import.meta.dir, "..");
const fixturesRootRel = path.join("tests", "fixtures", "llm-docs");

async function runCli(args: string[]) {
  const proc = Bun.spawn(["bun", path.join(repoRoot, "tools", "search.ts"), ...args], {
    cwd: repoRoot,
    stdout: "pipe",
    stderr: "pipe",
  });

  const [stdout, stderr, code] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);

  return { stdout, stderr, code };
}

function normalizeRootInJson(jsonText: string) {
  const parsed = JSON.parse(jsonText) as any;
  if (parsed && typeof parsed === "object" && typeof parsed.root === "string") {
    parsed.root = "<ROOT>";
  }
  return parsed;
}

test("cli: versions (text + json)", async () => {
  const text = await runCli(["versions", "--root", fixturesRootRel]);
  expect(text.code, text.stderr).toBe(0);
  expect(text.stderr).toBe("");
  expect(text.stdout).toMatchSnapshot();

  const json = await runCli(["versions", "--root", fixturesRootRel, "--json"]);
  expect(json.code, json.stderr).toBe(0);
  expect(json.stderr).toBe("");
  expect(normalizeRootInJson(json.stdout)).toMatchSnapshot();
});

test("cli: search supports -- end-of-flags", async () => {
  const res = await runCli(["search", "--root", fixturesRootRel, "--version", "1.0.0", "--", "--weird"]);
  expect(res.code, res.stderr).toBe(0);
  expect(res.stderr).toMatchSnapshot();
  expect(res.stdout).toMatchSnapshot();
});

test("cli: search --json", async () => {
  const res = await runCli(["search", "--root", fixturesRootRel, "--version", "1.0.0", "--json", "foo"]);
  expect(res.code, res.stderr).toBe(0);
  expect(res.stderr).toBe("");
  expect(normalizeRootInJson(res.stdout)).toMatchSnapshot();
});

test("cli: get + open by chunk id + symbols key", async () => {
  const id = "1.0.0/runtime/class/Foo#bar";

  const getRes = await runCli(["get", "--root", fixturesRootRel, "--version", "1.0.0", id]);
  expect(getRes.code, getRes.stderr).toBe(0);
  expect(getRes.stderr).toMatchSnapshot();
  expect(getRes.stdout).toMatchSnapshot();

  const openId = await runCli(["open", "--root", fixturesRootRel, "--version", "1.0.0", id]);
  expect(openId.code, openId.stderr).toBe(0);
  expect(openId.stderr).toMatchSnapshot();
  expect(openId.stdout).toMatchSnapshot();

  const openRelPathAnchor = await runCli(["open", "--root", fixturesRootRel, "--version", "1.0.0", "runtime/classes/Foo.md#bar"]);
  expect(openRelPathAnchor.code, openRelPathAnchor.stderr).toBe(0);
  expect(openRelPathAnchor.stderr).toMatchSnapshot();
  expect(openRelPathAnchor.stdout).toMatchSnapshot();

  const openSymbol = await runCli(["open", "--root", fixturesRootRel, "--version", "1.0.0", "runtime:method:Foo.bar"]);
  expect(openSymbol.code, openSymbol.stderr).toBe(0);
  expect(openSymbol.stderr).toMatchSnapshot();
  expect(openSymbol.stdout).toMatchSnapshot();
});

test("cli: call + open --call", async () => {
  const id = "1.0.0/runtime/class/Foo#bar";

  const callById = await runCli(["call", "--root", fixturesRootRel, "--version", "1.0.0", id]);
  expect(callById.code, callById.stderr).toBe(0);
  expect(callById.stderr).toMatchSnapshot();
  expect(callById.stdout).toMatchSnapshot();

  const callBySymbol = await runCli([
    "open",
    "--call",
    "--root",
    fixturesRootRel,
    "--version",
    "1.0.0",
    "runtime:method:Foo.bar",
  ]);
  expect(callBySymbol.code, callBySymbol.stderr).toBe(0);
  expect(callBySymbol.stderr).toMatchSnapshot();
  expect(callBySymbol.stdout).toMatchSnapshot();
});
