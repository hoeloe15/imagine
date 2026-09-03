# Hosting imagine over HTTP

Stdio is the default and is what you want on your own machine. This page covers
the other case: a server other machines and other people talk to. For the
step-by-step Azure deployment, see
[docs/deploy/azure-wizard.md](deploy/azure-wizard.md).

## Running over HTTP

For a server on another machine — a box on the LAN, a tunnel, a container — the
same binary also speaks MCP over Streamable HTTP:

```sh
npx -y imagine-mcp@latest --http
# from a clone: node dist/index.js --http
# or set IMAGINE_TRANSPORT=http instead of passing the flag
```

That serves one MCP endpoint at `http://127.0.0.1:3000/mcp`, accepting POST, and
a separate health endpoint at `http://127.0.0.1:3000/healthz`. Point Claude Code
at it with:

```sh
claude mcp add --transport http imagine http://127.0.0.1:3000/mcp
```

> ### ⚠️ The HTTP endpoint is UNAUTHENTICATED until you configure a tenant
>
> Out of the box there is no authentication. Anyone who can reach the port can
> generate images, **spend your provider credits** and read the files the server
> writes. It binds to `127.0.0.1` for that reason, and it prints the same warning
> every time it starts. Before putting it on an address anyone else can reach,
> set the `IMAGINE_AUTH_*` variables below — the banner then flips to say what it
> is enforcing.

Four environment variables configure the listener:

| Variable                       | Default     | What it does                                                       |
| ------------------------------ | ----------- | ------------------------------------------------------------------ |
| `IMAGINE_TRANSPORT`            | `stdio`     | `http` starts the HTTP listener instead of stdio                   |
| `IMAGINE_HTTP_HOST`            | `127.0.0.1` | Bind address. Widening it is an explicit choice                    |
| `IMAGINE_HTTP_PORT`            | `3000`      | Port. `0` picks a free one and prints it                           |
| `IMAGINE_HTTP_ALLOWED_ORIGINS` | *(empty)*   | Comma-separated browser origins allowed to call `/mcp`             |

Requests are handled statelessly: no sessions, nothing kept between calls. A
browser request whose `Origin` is neither the server's own nor a loopback
address nor on the allow-list gets a `403`, which is what blocks DNS rebinding.
Requests with no `Origin` — every desktop MCP client — are unaffected. A `GET` on
`/mcp` answers `405`; probe `/healthz` instead. See
[ADR 0016](adr/0016-streamable-http-transport.md).

## Requiring a Microsoft Entra ID token

Set these and every POST to `/mcp` must carry a bearer token this server has
verified itself — signature against the tenant's published keys, issuer,
audience, tenant, expiry and permission — before any tool runs. `/healthz` stays
open so probes keep working.

| Variable                      | Default                                             | What it does                                                        |
| ----------------------------- | --------------------------------------------------- | ------------------------------------------------------------------- |
| `IMAGINE_AUTH_TENANT_ID`      | *(empty — auth off)*                                | The Entra tenant whose signing keys and `tid` are accepted           |
| `IMAGINE_AUTH_AUDIENCE`       | *(required once auth is on)*                        | Accepted `aud`, comma-separated. Include the MCP URL itself          |
| `IMAGINE_AUTH_ISSUER`         | `https://login.microsoftonline.com/<tenant>/v2.0`   | Accepted `iss`                                                       |
| `IMAGINE_AUTH_REQUIRED_SCOPE` | `access_as_user`                                    | Accepted `scp` entries or app `roles` entries; any one is enough     |

With none of them set the endpoint is open, exactly as before. With some of them
set but not the tenant or the audience, the server refuses to start rather than
quietly serving an open endpoint.

A request with no token, an expired one, one minted for another audience, tenant
or issuer, or one whose signature does not check out gets a `401` with a
`WWW-Authenticate: Bearer` challenge and a JSON-RPC error body. A valid token
without the required permission gets `403 insufficient_scope`. Claude Code can
present the token directly:

```sh
claude mcp add --transport http imagine https://your-host/mcp \
  --header "Authorization: Bearer $(az account get-access-token \
    --resource https://your-host/mcp --query accessToken -o tsv)"
```

Registering the app in Entra — including the Application ID URI trap that makes
the MCP URL itself a valid audience — is in
[docs/deploy/azure-wizard.md](deploy/azure-wizard.md); the reasoning is in
[ADR 0017](adr/0017-entra-bearer-token-validation.md).

One caveat worth knowing before you share the URL with a colleague:
`budget.max_usd_per_session` is enforced per process, so over HTTP it becomes a
single bucket shared by everyone talking to that server rather than a per-person
cap. `max_usd_per_day` behaves the same way.

## Telling Claude where to log in

A `401` on its own says "go away", not "go here". So with authentication on, the
server also publishes an [RFC 9728](https://www.rfc-editor.org/rfc/rfc9728)
protected-resource document — the small JSON file that tells a Claude client
which Entra tenant to authenticate against — and points the `401` at it:

```
WWW-Authenticate: Bearer resource_metadata="https://your-host/.well-known/oauth-protected-resource/mcp", scope="access_as_user"
```

Both `/.well-known/oauth-protected-resource/mcp` and the bare
`/.well-known/oauth-protected-resource` serve it, with `GET`, **without a
token** — a client that cannot read it while unauthenticated can never become
authenticated. With authentication off, neither path exists at all.

The one thing it needs from you is this server's own public URL, because behind
a proxy or a container ingress the `Host` header is the internal one and the
`resource` field has to be the URL **you type into your client**, path included:

| Variable                   | Default                                              | What it does                                                            |
| -------------------------- | ---------------------------------------------------- | ----------------------------------------------------------------------- |
| `IMAGINE_PUBLIC_URL`       | *(the first `IMAGINE_AUTH_AUDIENCE` that is a URL)*   | The public origin, e.g. `https://your-host`. `/mcp` is appended          |
| `IMAGINE_MCP_RESOURCE_URI` | *(derived from the above)*                           | The whole endpoint URL, for a proxy that serves it on a different path   |

If you followed the Azure runbook you need neither: the MCP URL is already the
first accepted audience, and that is what the server falls back to. If it cannot
work the URL out, it says so in block capitals at startup and serves no
metadata — Claude then cannot connect, so this is not a warning to skip past.

Check it with:

```sh
curl -i -X POST https://your-host/mcp -H 'Content-Type: application/json' -d '{}'
curl -s https://your-host/.well-known/oauth-protected-resource/mcp
```

The first must be a `401` carrying the header above — Claude ignores a
`WWW-Authenticate` on a `200`, so a server that answers politely instead of
refusing never starts a login. The second must be `200`, and its `resource` must
equal your endpoint URL exactly: same case, same path, no trailing slash. The
reasoning, and why the Azure deployment uses no platform ("Easy Auth")
authentication, is in
[ADR 0021](adr/0021-protected-resource-metadata-and-no-platform-auth.md).

## Running it in a container

[`Containerfile`](../Containerfile) builds the image the Azure deployment runs,
and it works the same on your own machine:

```sh
docker build -f Containerfile -t imagine .
docker run --rm -p 8080:8080 -e OPENROUTER_API_KEY=... imagine
```

That serves `http://127.0.0.1:8080/mcp` and `http://127.0.0.1:8080/healthz`. The
image sets `IMAGINE_TRANSPORT=http` and `IMAGINE_HTTP_HOST=0.0.0.0` — binding
wide is correct inside a container and nowhere else — runs as an unprivileged
user, and listens on `IMAGINE_HTTP_PORT`, falling back to `PORT` (the Container
Apps convention) and then `8080`. The warning above still applies: nothing in
the image authenticates the endpoint.

Images, the manifest and the cost ledger are written to `/app/imagine-output`.
Mount something there to keep them, and mount something writable there if you
run with `--read-only`:

```sh
docker run --rm -p 8080:8080 --read-only \
  --tmpfs /app/imagine-output:uid=1000,gid=1000 \
  -e OPENROUTER_API_KEY=... imagine
```

Published images are at `ghcr.io/hoeloe15/imagine` — `latest` and the version
for a release, `edge` for the current `main`. See
[ADR 0018](adr/0018-the-container-image.md).

## The Azure deployment, in more detail

The [README](../README.md#put-it-in-the-cloud-and-why-youd-want-to) has the
three commands and the three switches. A few details that live here:

**What `azd up` provisions**, in your own subscription: a resource group holding
a Container Apps environment and one container app, a container registry, a Key
Vault, a user-assigned managed identity and a Log Analytics workspace — and it
builds and pushes the image from your working tree. Around two minutes on a warm
subscription, longer the first time. The app runs with one replica always on,
deliberately: a scale-to-zero cold start happens inside a tool call and reads to
the user as a broken connector.

**Azure OpenAI on the hosted server** is the same shape as the OpenRouter key:
either a key in the vault as `azure-openai-api-key` with
`IMAGINE_AZURE_OPENAI_SECRET_IN_VAULT true`, or — better — no key at all, by
setting `IMAGINE_FOUNDRY_RESOURCE_ID` to the resource id of your Foundry
account, which grants the container's identity **Cognitive Services OpenAI
User** on it. Either way the endpoint and the deployment mapping travel in
[`IMAGINE_CONFIG_JSON`](configuration.md#imagine_config_json-for-hosts-with-no-config-file).

**Your endpoint** is `https://<fqdn>`, always available again as:

```powershell
azd env get-value MCP_ENDPOINT_URL   # https://ca-imagine-....azurecontainerapps.io
azd env get-value MCP_RESOURCE_URI   # the same, with /mcp
```

`/healthz` answers `200` whether authentication is on or off. With it on,
`https://<fqdn>/.well-known/oauth-protected-resource/mcp` is the document that
tells a Claude client which tenant to log in against.

The reasoning is in [ADR 0020](adr/0020-the-azd-template.md) and
[ADR 0022](adr/0022-hosted-config-and-managed-identity.md).
