# Agent Notes — LLM Docs Export (Factorio API)

This directory contains an LLM-friendly export of the vendored Factorio API docs.

## Quick Start

- Prefer the latest version folder under `llm-docs/` (e.g. `llm-docs/2.0.72/`).
- Start from `llm-docs/<version>/SEARCH.md` for curated entry points by task.
- If you need broad browsing: `llm-docs/<version>/runtime/*/index.md` and `llm-docs/<version>/prototype/*/index.md`.

## Stage Semantics (Modding)

- `runtime/` = control stage (things you can call while the game is running): `Lua*` classes, events, runtime concepts/defines.
- `prototype/` = data stage (prototype definitions in `data.lua`): prototypes, types, defines.

When answering “can I do X at runtime?”, keep this split explicit.

## Names vs API Docs

The API docs describe *interfaces*, not always the *set of vanilla prototype names*.

Examples:

- “Stone tile” / “stone-path” is a tile prototype name used by base game, but the docs may not list it as a canonical enum.
- To discover names at runtime: use `LuaTile.name` and `prototypes.tile[...]` / `LuaPrototypes.get_tile_filtered`.

## Prefer Structured Sources

The export includes both readable Markdown and machine-readable sources:

- `llm-docs/<version>/chunks.jsonl` — best for RAG ingestion; each record has `id`, `stage`, `kind`, `name`, `text`, and a `relMarkdownPath`.
- `llm-docs/<version>/runtime-api.json` / `prototype-api.json` — original JSON formats (useful for tooling or stricter parsing).

## Link Expectations

- Internal references are rewritten to local Markdown links where possible.
- External references (e.g. `lua.org` tutorials) remain external.

## Suggestion for Retrieval

For best results, retrieve narrowly-scoped chunks first:

- class method: `.../runtime/class/<Class>#<method>`
- class attribute: `.../runtime/class/<Class>#<attribute>`
- prototype property: `.../prototype/prototype/<Prototype>#<property>`

If you need context, also pull the corresponding symbol page from `relMarkdownPath`.

