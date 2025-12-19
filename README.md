# factorio-llm-docs

Tools and workflows to generate an LLM-friendly export of the Factorio Lua API docs.

## Local usage

Prereqs:

- `mise` (optional)
- `bun`
- `unzip`

Commands:

- List available versions/channels: `mise run versions` (or `bun tools/factorio-docs.ts versions`)
- Generate docs for a target: `mise run generate -- latest` (or `stable`, or `2.0.72`)
- Generate for a channel + newest 5: `mise run generate-last5 -- stable` (or `latest`)
- Generate stable + latest + newest 5 (deduped) and build the browsable site: `mise run generate-all`
- Smoke checks (cached inputs + bun test snapshots): `FACTORIO_SMOKE_VERSION=2.0.72 mise run smoke-update`, then `FACTORIO_SMOKE_VERSION=2.0.72 mise run smoke`
- Query generated docs locally: `mise run docs -- search "LuaSurface.set_tiles"` / `mise run docs -- call "runtime:method:LuaSurface.set_tiles"`

Generated output:

- `llm-docs/index.html` — GitHub Pages entrypoint (browsable HTML)
- `llm-docs/<version>/index.html` — version entrypoint (browsable HTML)
- `llm-docs/<version>/SEARCH.html` — curated jump list (HTML)
- `llm-docs/<version>/chunks.jsonl` — chunked text for RAG
- `llm-docs/<version>/*.md` — Markdown sources (also used by agents)

This repo does not commit generated `llm-docs/<version>/` outputs. CI publishes them to GitHub Pages and attaches per-version archives to GitHub Releases.

## Using With AI Agents

GitHub Pages (`llm-docs/index.html` and friends) is primarily for humans.

For AI agents / tooling:

- Prefer `llm-docs/<version>/chunks.jsonl` for RAG ingestion (chunked text + stable metadata).
- Prefer `llm-docs/<version>/*.md` for “paste into context” or when you want a readable canonical source.
- Use `llm-docs/<version>/SEARCH.md` as the starting jump list when you don’t know which API surface you need.
- See `llm-docs/AGENTS.md` for agent-oriented notes and retrieval tips.

### `chunks.jsonl` schema contract

Each line in `llm-docs/<version>/chunks.jsonl` is a JSON object with:

- Required: `id` (string), `version` (string), `stage` (runtime|prototype|auxiliary), `kind` (string), `name` (string), `text` (string)
- Optional: `member` (string), `relPath` (string, relative to `llm-docs/<version>/`), `anchor` (string)
- Optional (call metadata): `call` (string), `takes_table` (boolean), `table_optional` (boolean)

Notes:

- `id` is version-scoped and typically starts with `<version>/...` (treat it as an opaque identifier; don’t assume cross-version stability).
- If present, `relPath` + `anchor` locates the canonical Markdown section for the chunk (e.g. `runtime/classes/LuaEntity.md#clone`).

## Tooling Roadmap

See `TOOLING.md` for recommended next tooling (local search CLI, MCP server, optional SQLite index, and version diff tooling).
