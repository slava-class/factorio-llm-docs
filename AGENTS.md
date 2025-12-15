# Agent Notes (factorio-llm-docs)

This repo generates an LLM-friendly export of the Factorio Lua API docs.

## CI (GitHub Actions)

Workflows live under `.github/workflows/`:

- `.github/workflows/nightly.yml`
  - Trigger: scheduled daily (06:00 UTC) and manual (`workflow_dispatch`)
  - Action: generate `stable + latest + last5` via `bun tools/factorio-docs.ts generate-all`, then build `llm-docs/index.html` via `bun tools/build-site.ts` and `bun tools/site-index.ts`
  - Publish: deploys `llm-docs/` to GitHub Pages

- `.github/workflows/generate.yml`
  - Trigger: manual (`workflow_dispatch`) or on version tags like `2.0.72` / `v2.0.72`
  - Action:
    - Tags: generate that exact version
    - Manual: generate newest set via `generate-all`
    - Always builds the site (`build-site.ts`, `site-index.ts`)
  - Artifacts: uploads `llm-docs/*` and (when generating a single version) `llm-docs-<version>.tar.gz`
  - Releases: on tags, creates/updates a GitHub Release and attaches `llm-docs-<version>.tar.gz`
  - Publish: deploys `llm-docs/` to GitHub Pages (tags + manual runs)

## Smoke-Check Loop (Local / Mikado)

This repo includes a local “smoke check” loop intended for rapid iteration (not primarily for CI):

- Cache Factorio input files (once per version):
  - `mise run setup-smoke-input -- 2.0.72`
- Run smoke test (uses cached inputs + snapshots):
  - `FACTORIO_SMOKE_VERSION=2.0.72 mise run smoke`
- Update snapshots when you intentionally change output:
  - `FACTORIO_SMOKE_VERSION=2.0.72 mise run smoke-update`

### What gets cached

Cached inputs live under:

- `.work/factorio-api-input/<version>/runtime-api.json`
- `.work/factorio-api-input/<version>/prototype-api.json`
- `.work/factorio-api-input/<version>/auxiliary/*.html`

They are downloaded from `https://lua-api.factorio.com/<version>/static/archive.zip` via:

- `tools/factorio-docs.ts` (`fetch-input` command)

### Where the smoke test runs

The smoke test runs the generator with `cwd` set to the cached input directory, writing output under:

- `.work/factorio-api-input/<version>/.smoke-out/<version>/...`

The smoke test leaves this output directory in place for inspection. To clean it up:

- `mise run smoke-clean -- 2.0.72`

Smoke test source:

- `tests/smoke.test.ts`

## Local Docs CLI (Search / Get / Open)

This repo includes a small CLI for querying the generated corpus under `llm-docs/`.

Entrypoint (recommended):

- `mise run docs -- versions`
- `mise run docs -- search "<query>" [--version <x.y.z>] [--limit <n>] [--stage runtime,prototype,auxiliary] [--kind <kinds>] [--name <names>] [--member <members>]`
- `mise run docs -- search "<query>" --json`
- `mise run docs -- get "<chunkId>" [--version <x.y.z>]`
- `mise run docs -- open "<chunkId|relPath|symbolKey>" [--version <x.y.z>]`
- If your query/path starts with `--`, use end-of-flags:
  - `mise run docs -- search -- "--weird"`

Useful flags:

- Open the top search hit directly: `mise run docs -- search "<query>" --open`
- Print only chunk ids (one per line): `mise run docs -- search "<query>" --print-ids`
- Suppress the `Using version: ...` banner on stderr: `mise run docs -- ... --quiet`

Implementation:

- `tools/search.ts`
