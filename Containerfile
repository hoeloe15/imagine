# The image Azure Container Apps runs. Dockerfile syntax; see ADR 0018 for the
# name, the base image and the PORT convention.
#
#   docker build -f Containerfile -t imagine .
#   docker run --rm -p 8080:8080 -e OPENROUTER_API_KEY=... imagine

# ---- deps: production node_modules only -------------------------------------
# tsup bundles our own modules but leaves @modelcontextprotocol/sdk and zod
# external, so the runtime still needs a node_modules tree.
FROM node:22-slim AS deps
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev --ignore-scripts

# ---- build: full toolchain, produces dist/ ----------------------------------
FROM node:22-slim AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --ignore-scripts
COPY tsconfig.json tsup.config.ts ./
COPY src ./src
RUN npm run build

# ---- runtime ----------------------------------------------------------------
FROM node:22-slim AS runtime
ENV NODE_ENV=production

# The transport is chosen by environment here, not by argv, and a container that
# binds 127.0.0.1 is unreachable from the ingress. This is the one place where
# binding wide is correct; the local default stays 127.0.0.1 (ADR 0016).
# The port is not set here: the entrypoint resolves IMAGINE_HTTP_PORT, then
# Container Apps' PORT, then 8080.
ENV IMAGINE_TRANSPORT=http \
    IMAGINE_HTTP_HOST=0.0.0.0

WORKDIR /app

# `src/version.ts` reads package.json and `src/core/knowledge.ts` walks up from
# dist/ looking for data/models.json, so the runtime layout is package.json +
# dist/ + data/ + schema/ under one root, not a bare bundle.
COPY --chown=node:node package.json ./
COPY --chown=node:node data ./data
COPY --chown=node:node schema ./schema
COPY --from=deps --chown=node:node /app/node_modules ./node_modules
COPY --from=build --chown=node:node /app/dist ./dist
COPY --chown=node:node deploy/container-entrypoint.sh /usr/local/bin/imagine-entrypoint

# Images and the cost ledger are written under ./imagine-output. With a
# read-only root filesystem this path must be a writable mount; without one the
# server still starts, answers /healthz and serves list_capabilities and
# recommend_model, and only generate_image fails.
RUN mkdir -p /app/imagine-output \
    && chown node:node /app/imagine-output \
    && chmod +x /usr/local/bin/imagine-entrypoint

# Numeric, not `node`: a platform that enforces runAsNonRoot rejects an image
# whose user is a name it cannot resolve. 1000:1000 is the node user.
USER 1000:1000

EXPOSE 8080

# Node 22 has a global fetch, so the probe needs no curl in the runtime image.
# `/healthz`, never `/mcp` — an MCP endpoint answers POSTs and a GET is a 405.
HEALTHCHECK --interval=30s --timeout=3s --start-period=10s --retries=3 \
    CMD ["node", "-e", "const p=process.env.IMAGINE_HTTP_PORT||process.env.PORT||8080;fetch('http://127.0.0.1:'+p+'/healthz').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"]

ENTRYPOINT ["/usr/local/bin/imagine-entrypoint"]
CMD ["node", "dist/index.js"]
