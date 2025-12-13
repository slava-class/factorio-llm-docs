# factorio-llm-docs

Tools and workflows to generate an LLM-friendly export of the Factorio Lua API docs.

## Local usage

Prereqs:

- `mise` (optional)
- `bun`
- `unzip`

Commands:

- List available versions/channels: `mise run versions` (or `bun tools/factorio-docs.ts versions`)
- Generate docs for a target: `mise run generate -- latest` (or `stable`, `experimental`, or `2.0.72`)
- Generate for a channel + newest 5: `mise run generate-last5 -- stable` (or `experimental`)
- Generate stable + experimental + newest 5 (deduped) and build the browsable site: `mise run generate-all`

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

- Prefer `llm-docs/<version>/chunks.jsonl` for RAG ingestion (each line includes `id`, `stage`, `kind`, `name`, `text`, and `relMarkdownPath`).
- Prefer `llm-docs/<version>/*.md` for “paste into context” or when you want a readable canonical source.
- Use `llm-docs/<version>/SEARCH.md` as the starting jump list when you don’t know which API surface you need.
- See `llm-docs/AGENTS.md` for agent-oriented notes and retrieval tips.
