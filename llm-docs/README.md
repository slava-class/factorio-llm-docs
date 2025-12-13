# LLM Docs (Generated)

This folder is intended to hold an LLM-friendly export of the vendored Factorio API docs in `factorio-api-docs/`.

Generator:

- `tools/factorio-api-docs-to-llm.ts`

Run (from `factorio-api-docs/`):

- `bun tools/factorio-api-docs-to-llm.ts`

Outputs (versioned):

- `llm-docs/<factorio-version>/runtime/` — control stage (runtime) API: classes, events, concepts, defines, globals
- `llm-docs/<factorio-version>/prototype/` — data stage (prototype) API: prototypes, types, defines
- `llm-docs/<factorio-version>/auxiliary/` — auxiliary docs converted from HTML
- `llm-docs/<factorio-version>/SEARCH.md` — curated entry points for common modding tasks
- `llm-docs/<factorio-version>/chunks.jsonl` — RAG-friendly chunks with metadata
- `llm-docs/<factorio-version>/manifest.json` — counts and paths
