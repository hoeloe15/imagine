# imagine

A capability router for image generation, exposed as an MCP server. AI clients
like Claude Code, Codex and Cursor can generate images through one stable tool
interface while the providers behind it — Azure OpenAI, OpenRouter, Google
Gemini, xAI — stay swappable. It ships with curated, regularly updated knowledge
about which image model is good at what and what it costs, so the client can pick
deliberately instead of relying on a choice hard-coded months ago. Generated
images are written to disk and returned as a file path, never as base64 in the
tool result.

## Status

**Early design.** Nothing is implemented yet. See [PLAN.md](PLAN.md) for the
architecture, tool API, data model and phasing.

## Planned features

- MCP server over stdio, installable with `npx`
- Provider-agnostic tools: `generate_image`, `list_capabilities`, `recommend_model`
- Providers: OpenRouter and Azure OpenAI first, then Google Gemini and xAI Grok
- Curated model knowledge in `data/models.json` — strengths per use case,
  indicative pricing, availability per provider
- Recommendations that state the trade-off, including "the cheap model is fine
  for this"
- Per-generation cost logging and optional daily/session budget limits
- Images written to a directory you choose; path plus metadata returned
- Later: a local web portal for key management and a searchable gallery of
  everything generated
- Later: an `azd up` template for a governed deployment in your own Azure tenant

## Documentation

- [PLAN.md](PLAN.md) — the design
- [docs/research/providers-2026-08.md](docs/research/providers-2026-08.md) — provider API research
- [docs/issues-draft.md](docs/issues-draft.md) — planned work

## License

To be decided before first release.
