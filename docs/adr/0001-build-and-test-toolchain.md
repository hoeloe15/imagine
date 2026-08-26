# 1. Build and test toolchain

**Status:** accepted
**Date:** 2026-08-26

## Context

The scaffold needed a build, a test runner, lint and format for a TypeScript ESM
package whose deliverable is a single `npx`-launched binary.

## Decision

- **tsup** for the build. It emits one ESM bundle with the `#!/usr/bin/env node`
  banner already attached, so the `bin` entry works without a separate
  shebang-prepending step. `tsc` stays in the toolchain as `npm run typecheck`
  (`--noEmit`), because tsup transpiles without type checking.
- **vitest** as the test runner, with ESM and TypeScript working out of the box.
- **ESLint (flat config) + Prettier**, with `eslint-config-prettier` so the two
  do not fight. Prettier ignores `*.md`: the prose in this repo is hand-wrapped
  and Prettier reflows it destructively.
- `npm test` builds first (`pretest`), because the end-to-end test spawns
  `dist/index.js` — it is the built binary that must work, not the sources.

## Consequences

The build does not fail on type errors, so `typecheck` must run in CI as its own
step. In exchange the build is fast and the published artefact is one file.
