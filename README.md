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

**Early development.** The MCP server starts, speaks the protocol and exposes
the first of its three planned tools: `generate_image` routes a prompt to a
configured provider, writes the image to disk and returns its path, what it
cost and why that model was chosen. `list_capabilities` and `recommend_model`
do not exist yet, and the configuration story is not documented yet. See
[PLAN.md](PLAN.md) for the architecture, tool API, data model and phasing.

## Install and run

Requires Node 20 or newer.

```sh
npx imagine-mcp
```

The server speaks MCP over stdio, so it is meant to be launched by an MCP client
rather than run by hand. In a client's MCP configuration:

```json
{
  "mcpServers": {
    "imagine": {
      "command": "npx",
      "args": ["-y", "imagine-mcp"]
    }
  }
}
```

The package is not published to npm yet, so for now run it from a clone (see
below).

## Development

```sh
npm install     # install dependencies
npm run build   # bundle src/index.ts to dist/ with tsup
npm test        # build, then run the vitest suite
npm run lint    # eslint
npm run format  # prettier --write
```

`npm run typecheck` runs `tsc --noEmit` over `src` and `test`. CI runs lint,
format check, typecheck and tests on every push to `main` and every pull
request.

To run the local build as a server, point your MCP client at
`node <repo>/dist/index.js`, or `npm link` the package and use `imagine`.

### Layout

| Path             | What lives there                                |
| ---------------- | ----------------------------------------------- |
| `src/index.ts`   | binary entry point: starts the stdio server     |
| `src/mcp/`       | MCP protocol wiring and tool definitions        |
| `src/core/`      | router, config, knowledge, budget, output       |
| `src/providers/` | one adapter per image provider                  |
| `data/`          | curated model knowledge (`models.json`)         |
| `schema/`        | JSON Schema for the user config file            |
| `test/`          | `unit/`, `contract/`, `live/` and `e2e/` suites |

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

[MIT](LICENSE)
