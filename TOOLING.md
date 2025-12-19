# Tooling Roadmap (Human-Friendly + AI-Friendly Factorio Mod Docs)

This repo already generates a browsable static site for humans and an LLM-friendly corpus for agents. This document describes:

- What exists today (pipeline + artifacts).
- What tooling is worth building next (CLI search, MCP server, indexes, diffs).
- Small format improvements that make downstream tooling simpler and more reliable.

## Current State (What You Already Have)

### Source → Export Pipeline

The pipeline is implemented in:

- `tools/factorio-docs.ts`: version discovery + download `archive.zip` from `https://lua-api.factorio.com`, extract inputs, run the generator.
- `tools/factorio-api-docs-to-llm.ts`: converts Factorio’s JSON docs (+ auxiliary HTML) into:
  - readable Markdown pages (for humans and “paste into context”)
  - a chunked JSONL corpus (for RAG/tooling)
  - a manifest with counts/paths
- `tools/build-site.ts`: builds a small static HTML site from generated Markdown.
- `tools/site-index.ts`: builds `llm-docs/index.html` and per-version link lists.

### Generated Artifacts

Per version under `llm-docs/<version>/`:

- `runtime/` — control stage API (`classes/`, `events/`, `concepts/`, `defines/`, globals).
- `prototype/` — data stage API (`prototypes/`, `types/`, `defines/`).
- `auxiliary/` — auxiliary docs converted from HTML (mod structure, lifecycle, migrations, etc.).
- `SEARCH.md` — curated “jump list” for common modding tasks.
- `chunks.jsonl` — chunked text for RAG/tooling (one JSON record per line).
- `manifest.json` — version, timestamps, counts, and output paths.
- `runtime-api.json` / `prototype-api.json` — machine-readable originals (useful for stricter parsing or diffs).

For humans:

- `llm-docs/index.html` — top-level entrypoint (GitHub Pages).
- `llm-docs/<version>/index.html` + HTML-ified pages.

### `chunks.jsonl` Record Shape (Today)

Each line contains metadata plus a chunk of text, roughly:

- `id`: stable-ish canonical ID (often includes stage/kind/name and `#anchor` for members).
- `version`, `stage` (`runtime`/`prototype`/`auxiliary`), `kind`, `name`, optional `member`.
- `anchor`: when applicable.
- `relPath`: points at the Markdown source page (version-root-relative, e.g. `runtime/classes/LuaEntity.md`).
- `call`: canonical call snippet when available (e.g. `surface.set_tiles(tiles, true)` or `surface.spill_item_stack{ position=..., stack=... }`).
- `takes_table` / `table_optional`: call-convention flags from the upstream JSON docs (Factorio’s `format.takes_table` / `format.table_optional`).
- `text`: the chunk content (usually includes a heading like `# LuaEntity.clone (method)`).

This is already good enough to build robust retrieval tooling on top of.

## Goal: One Source of Truth, Two “Products”

- **Humans**: fast, simple static browsing (your current HTML output).
- **Agents**: deterministic access to the right symbols with stable identifiers, filters (runtime vs prototype), and citations.

The next steps should primarily improve *how agents access and trust the corpus*, not create a new export format.

## Next Tooling to Build (Recommended Order)

### 1) Local Search CLI (No LLM Required)

This repo includes a small CLI (`tools/search.ts`) that can query the corpus and return citation-ready hits:

- `search <query>`: ranked results with snippet + IDs.
- `get <id>`: return one chunk by exact ID.
- `open <id|path>`: print Markdown (or open file) for interactive browsing.
- `call <id|symbolKey>`: print canonical call form + call convention metadata (for methods/functions).
- `versions`: list versions present under `llm-docs/`.

#### `related` (Documented, Not Implemented Yet)

`related <id>` can work cleanly with the current `chunks.jsonl` shape, but it needs a clearly-defined meaning:

- **Same page neighbors (recommended default)**: find the chunk by `id`, then return other chunks with the same `relPath` (optionally ordered by Markdown heading order, and/or grouped by `kind`).
- **Same symbol family**: for runtime classes/prototypes, return other chunks that share `stage` + `name` (and optionally `kind`), e.g. other `LuaEntity` members.

These both require only the fields you already have today (`id`, `stage`, `name`, optional `member`, plus `relPath`/`anchor`).

If you later want a **cross-reference graph** style `related` (“things this chunk links to” / “things that link to this chunk”), you’ll likely want generator-side metadata to avoid heuristics:

- `order` (a stable, per-page ordering index for each chunk) to return “neighbors” deterministically.
- A normalized anchor key for matching (e.g. `anchor_slug` as actually used in Markdown links).
- Optional `links: Array<{relPath, anchor?}>` extracted from Markdown to build a real link graph.

Must-have filters:

- `--version <x.y.z>` (default: latest present in `llm-docs/`).
- `--stage runtime|prototype|auxiliary`.
- `--kind class_method|class_attribute|event|prototype_property|...`.
- `--name <LuaEntity>` and `--member <clone>` when you already know the symbol.

Why this is high leverage:

- Gives humans and agents a stable “entrypoint” into `chunks.jsonl`.
- Provides deterministic behavior for evaluations/regressions (same query → same results).

Implementation approach:

- Start with streaming JSONL scan + simple scoring (fast enough for ~10–20k chunks).
- Optionally add an index (SQLite FTS) later for speed and better ranking (see below).

### 2) MCP Server (Agent-Native Docs Access)

Expose this repo’s corpus via MCP tools so any MCP-capable agent can use it safely.

Suggested tools:

- `list_versions() -> {versions: string[], latest: string}`
- `search({query, version?, stage?, kind?, name?, member?, limit?}) -> Hit[]`
- `get_chunk({id, version?}) -> ChunkRecord`
- `open_markdown({relPath, version?}) -> {text, relPath}`
- `diff_versions({from, to, scope?}) -> DiffSummary`

Design principles:

- Always return stable IDs and citation fields (`id`, `version`, `relPath`, `anchor`) alongside snippets.
- Make “runtime vs prototype” explicit in both input filters and outputs.

Why MCP is the right integration point:

- It decouples “agent framework choice” from “how to use these docs”.
- It lets you enforce a consistent citation contract across tools and prompts.

### 3) Optional: Per-Version SQLite Index (FTS5)

If you want faster search + better ranking, generate and ship:

- `llm-docs/<version>/index.sqlite`

Tables you’ll likely want:

- `chunks(id PRIMARY KEY, version, stage, kind, name, member, anchor, relPath, text)`
- `chunks_fts` (FTS5 over `text`, plus maybe `name/member` as separate columns for boosting).

Benefits:

- Very fast local search.
- Reproducible ranking if you control tokenization and scoring.
- Lets the CLI and MCP server share the same implementation for queries.

Tradeoffs:

- Larger artifact size.
- More “build” moving parts (schema migrations, generation time).

### 4) Version Diff Tooling (Modding Painkiller)

Build a diff tool that compares versions and produces:

- machine-readable `diff.json`
- human-readable `diff.md` (release notes for modders)

Scopes that matter most:

- Runtime API: added/removed/changed class methods/attributes, events, concepts.
- Prototype API: added/removed/changed prototype fields/types/defines.

Data sources:

- Use `runtime-api.json` / `prototype-api.json` for authoritative diffs.
- Optionally produce a derived “symbol table” as a stable diff basis (see `symbols.json` below).

Outputs should support:

- “What changed between 2.0.71 → 2.0.72?”
- “Show all breaking changes” (removals, signature changes, behavior notes when present).
- “Show changes for a symbol” (e.g., `LuaSurface.set_tiles`).

## Small Format Improvements (High ROI)

These are additive changes that make tooling simpler without breaking current usage patterns.

### Export a Simple `symbols.json`

Add a per-version lookup table:

- `llm-docs/<version>/symbols.json`

Suggested shape:

```json
{
  "runtime:class:LuaEntity": {"relPath":"runtime/classes/LuaEntity.md"},
  "runtime:method:LuaEntity.clone": {"relPath":"runtime/classes/LuaEntity.md","anchor":"clone","id":"2.0.72/runtime/class/LuaEntity#clone"},
  "prototype:prototype:EntityPrototype": {"relPath":"prototype/prototypes/EntityPrototype.md"},
  "...": {}
}
```

Why:

- A fast way to resolve “symbol → page/anchor/id”.
- Helps build `open()` and `diff()` tooling without re-parsing `chunks.jsonl`.
- Makes link rewriting, “related” queries, and diffs more deterministic.

### Make Markdown Paths Portable

`chunks.jsonl` includes `relPath` (posix, version-root-relative), e.g. `runtime/classes/LuaEntity.md`.

This makes CLI/MCP “open markdown” trivial and avoids path-rewriting in downstream tools.

## “LLM Tooling” Practices (December 2025 Reality)

These practices matter more than model choice:

- **Tool calling + structured outputs**: tools should return stable IDs and citation fields, not freeform text.
- **Retrieval gates**: for “API correctness” questions, require at least 1–3 citations (chunk IDs / relPaths) before answering.
- **Eval harness**: keep a small set of Q→expected-citations tests to detect regressions when Factorio updates or the generator changes.
- **Version awareness**: always surface the version in tool outputs; don’t let agents silently mix versions.

## Suggested Roadmap Checklist

1. Build `tools/search.ts` (or extend `tools/factorio-docs.ts`) to provide `search/get/open/related`.
2. Add an MCP server (new `tools/mcp-server.ts`) powered by the same search backend.
3. Add `symbols.json` + `relPath` output field(s).
4. Add optional `index.sqlite` generation.
5. Add `diff` generation between versions (JSON + Markdown).
