# Development

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
`node <repo>/dist/index.js`, or `npm link` the package and use `imagine`. In a
Claude Desktop config that is `"command": "node"` with
`["/absolute/path/to/imagine/dist/index.js"]`.

Inside the clone, `npx imagine-mcp` resolves to the local project rather than
the registry — see [Troubleshooting](troubleshooting.md).

## Layout

| Path             | What lives there                                |
| ---------------- | ----------------------------------------------- |
| `src/index.ts`   | binary entry point: picks stdio or HTTP         |
| `src/transport/` | the HTTP listener, routing and origin checks    |
| `src/mcp/`       | MCP protocol wiring and tool definitions        |
| `src/core/`      | router, config, knowledge, budget, output       |
| `src/providers/` | one adapter per image provider                  |
| `data/`          | curated model knowledge (`models.json`)         |
| `schema/`        | JSON Schema for the user config file            |
| `deploy/`        | the container entrypoint (see `Containerfile`)  |
| `test/`          | `unit/`, `contract/`, `live/` and `e2e/` suites |
