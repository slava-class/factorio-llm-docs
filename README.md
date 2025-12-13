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
- Generate for the channel version + newest 5: `mise run generate-last5 -- stable`

Generated output:

- `llm-docs/<version>/README.md` — entrypoint
- `llm-docs/<version>/SEARCH.md` — curated jump list
- `llm-docs/<version>/chunks.jsonl` — chunked text for RAG

This repo does not commit generated `llm-docs/<version>/` outputs. CI publishes them.
