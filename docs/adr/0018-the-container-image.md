# 18. The container image

**Status:** accepted
**Date:** 2026-08-28
**Follows:** [ADR 0016](0016-streamable-http-transport.md)

## Context

Azure Container Apps runs a container, so the HTTP transport of ADR 0016 needs
an image (issue #39). `docs/research/remote-mcp-2026-08.md` §5 fixes the
platform expectations: ingress over plain HTTP, min replicas 1, and health
probes on a separate path because a GET on `/mcp` is an error by design.

## Decision

**`Containerfile`, not `Dockerfile`.** Dockerfile syntax, a name that is not a
vendor's. Every tool that will build it takes the path explicitly —
`docker build -f Containerfile`, and `docker: path: ./Containerfile` in the
`azure.yaml` that #40 adds. That last line is the one thing this name costs, and
it is worth naming here so #40 does not discover it by failing.

**Three stages on `node:22-slim`.** `deps` runs `npm ci --omit=dev`; `build`
runs the full toolchain and `npm run build`; `runtime` copies both results into
a fresh slim base. tsup bundles our own modules but leaves
`@modelcontextprotocol/sdk` and `zod` external, so a runtime `node_modules` is
still required and the production-only tree from `deps` is what it gets. Debian
slim rather than Alpine: the dependency tree is pure JavaScript today, so musl
would work, but glibc is what Node's own release testing covers and the size
difference (242 MB) does not buy a musl surprise later.

**The runtime layout is a package, not a bare bundle.** `src/version.ts` reads
`package.json` and `src/core/knowledge.ts` walks *up* from its own module
directory looking for `data/models.json` — so the image holds `package.json`,
`dist/`, `data/` and `schema/` under one `/app` root. Copying `dist/index.js`
alone would produce a container that starts and then fails on the first tool
call, which is exactly the broken-install case the issue refuses.

**Non-root, as `1000:1000` rather than `node`.** A platform enforcing
`runAsNonRoot` rejects an image whose `USER` is a name it cannot resolve, and
hadolint's DL3066 says the same thing.

**The port is bridged in the entrypoint, not in the transport.** Container Apps
names the port `PORT`; the server reads `IMAGINE_HTTP_PORT`.
`deploy/container-entrypoint.sh` resolves `IMAGINE_HTTP_PORT`, then `PORT`, then
`8080`, and `exec`s the command so signals still reach node. Teaching the
transport a second port variable would put a hosting convention inside code that
has nothing to do with hosting.

`IMAGINE_TRANSPORT=http` and `IMAGINE_HTTP_HOST=0.0.0.0` are baked in as `ENV`.
Binding wide is correct here and only here; the local default stays `127.0.0.1`.

**Read-only root filesystem is supported but not assumed.** Images, the manifest
and the cost ledger are written under `./imagine-output`, which exists in the
image owned by the runtime user. With `--read-only` that path must be a writable
mount; without one the server still starts, answers `/healthz`, and serves
`list_capabilities` and `recommend_model` — only `generate_image` fails.

**The image is built by its own workflow, not by `ci.yml`.**
`.github/workflows/image.yml` builds on pull requests without pushing, and
pushes to `ghcr.io/hoeloe15/imagine` on `main`, on `v*` tags and on published
releases, authenticating with the workflow's `GITHUB_TOKEN` and
`packages: write`. Tags: `edge` for `main`, the semantic version plus
`{major}.{minor}` and `latest` for a release, and the full commit SHA always.
CI stays a lint-and-test loop; the image job carries the container-shaped
checks, including a smoke test that the container answers `/healthz` as a
non-root user and that `docker history` contains no credential.

## Consequences

`docker build -f Containerfile -t imagine .` then
`docker run -p 8080:8080 -e OPENROUTER_API_KEY=… imagine` serves MCP on
`http://127.0.0.1:8080/mcp`. A broken Containerfile now fails a pull request
rather than an `azd up` ten minutes in.

`azd` (#40) may either build from this file or deploy the published GHCR image;
whichever it does, it must name the file explicitly and must not re-declare the
transport environment the image already sets.
