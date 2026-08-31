# 20. The azd template

**Status:** accepted
**Date:** 2026-08-31
**Follows:** [ADR 0018](0018-the-container-image.md),
[ADR 0017](0017-entra-bearer-token-validation.md),
[ADR 0004](0004-config-loading-and-key-resolution.md)

## Context

Issues #40, #41 and #44 turn the container image of ADR 0018 into a deployment:
`azure.yaml` plus `infra/`, one `azd up`, no portal clicking.
`docs/research/remote-mcp-2026-08.md` §5 fixes the platform (Container Apps,
standalone), the operational shape (min replicas 1, probes on a path that is not
`/mcp`) and the one big unknown (whether the platform's built-in auth can serve
protected-resource metadata). Issue #38 — the spike that would settle that
unknown — is deliberately not done.

## Decision

**No Easy Auth.** The template configures no platform authentication at all.
The auth layer is the server's own token validation (ADR 0017), which is
configured by environment and therefore by this template. Building Easy Auth
before #38 has run would be guessing at the answer the spike exists to produce,
and ADR 0017 already says a server that is only safe because of where it is
deployed is not safe.

**Subscription-scoped `main.bicep`, resource-group-scoped `resources.bicep`.**
Every resource is created at resource-group scope; `main.bicep` exists only to
create the group and pass parameters down. This is the shape every azd template
has, and it is the only one where `azd up` against a clean subscription needs no
pre-made resource group.

**ACR is provisioned, and the GHCR image is what runs until `azd deploy`
replaces it.** Both registries were on the table: `image.yml` already publishes
`ghcr.io/hoeloe15/imagine`, so pulling that would skip a local Docker build and
an ACR bill.

The reason ACR wins as the *deploy* target is that azd's `containerapp` host is
built around "azd builds your working tree and pushes it to a registry it owns".
Pointing it at GHCR means either pinning a tag in `azure.yaml`'s `image:` field
— which deploys `main`, not the tree the operator has checked out, and gives up
`azd deploy` entirely — or running provision-only workflows and updating the
image by hand. Neither is the "one `azd up`" that #20 asks for.

The reason GHCR still earns its place is the **first-provision bootstrap**: a
brand-new ACR is empty, so the container app has no image to start from. The
usual azd answer is a placeholder like
`mcr.microsoft.com/k8se/quickstart:latest`, which produces a container app that
runs the wrong software. We have a better placeholder — the real one. So
`containerImage` defaults to `ghcr.io/hoeloe15/imagine:edge`, which means
`azd provision` on its own already yields a working `/healthz`, and `azd deploy`
then swaps in an ACR image built from the working tree.

The cost of this is that a bare `azd provision` after a deploy reverts the app to
the GHCR image. `azd up` provisions then deploys, so it self-corrects; an
operator running `azd provision` alone to flip a flag must follow it with
`azd deploy`. That is written in the runbook rather than engineered around,
because the alternative (reading the currently deployed image back out of an
`existing` resource) makes the template depend on its own previous state.

**The empty-secret bootstrap is solved by two passes, not by a placeholder
value.** A Container Apps secret whose value is a Key Vault reference is
resolved when the revision is created. If the secret does not exist in the
vault, the revision fails and the deployment fails with it — so the template
cannot reference `openrouter-api-key` before a human has put one there, and
issue #41 forbids the template from having the value.

Three options, and why the third:

- *Seed a placeholder secret from Bicep.* Every subsequent deployment would
  overwrite the operator's real key with the placeholder. Rotation would become
  "rotate, then never run `azd provision` again". Rejected.
- *Take the key as a `@secure()` parameter.* That puts the value in an `azd env`
  file and in the deployment history. Exactly what #41 exists to prevent.
  Rejected.
- *Gate the reference on a flag.* `openRouterSecretInVault` and
  `azureOpenAiSecretInVault` default to false; with them false the container app
  declares no secrets and no provider environment, starts fine, answers
  `/healthz`, and `list_capabilities` reports `not_configured` naming
  `OPENROUTER_API_KEY`. That is issue #40's deliberate intermediate state, and it
  is verifiable rather than merely broken. The operator sets the secret, flips
  the flag, provisions once more.

The flags are per provider so that Azure OpenAI can stay off while OpenRouter is
on. In steady state nothing about rotation changes: `az keyvault secret set`
plus a revision restart, no redeploy, because the reference points at the
secret's unversioned URI.

**The deploying principal gets Key Vault Secrets Officer.** An RBAC vault grants
no data-plane access to a subscription Owner, so without this role assignment
step 6 of the runbook fails on the operator's own vault. azd passes
`AZURE_PRINCIPAL_ID` for free; the assignment is skipped when it is empty.

**Purge protection is off and soft delete is seven days.** `azd down --purge`
must be able to reclaim the vault name; purge protection cannot be turned off
once it is on, and a trial deployment that permanently burns a name is worse
than the threat model it defends against here.

**The endpoint URL is derived in Bicep, so half of #44's chicken-and-egg
disappears.** The FQDN of a container app is
`<name>.<environment defaultDomain>`, and the environment's default domain is
known inside the same deployment. That makes `https://<fqdn>/mcp` computable
before the container app exists, so it is always an accepted audience in
`IMAGINE_AUTH_AUDIENCE` and it is emitted as the `MCP_RESOURCE_URI` output. What
is left of the egg is only the *app registration*, which needs that URL as an
Application ID URI — a directory object, not a subscription resource.

**`IMAGINE_TRANSPORT` and `IMAGINE_HTTP_HOST` are not in the template.** ADR
0018 sets them in the image and says not to re-declare them. `PORT` *is* set:
Container Apps does not inject it, and the entrypoint's
`IMAGINE_HTTP_PORT` → `PORT` → `8080` bridge is only a real contract if
something on the platform side sets it.

**Auth is off by default and turned on by one flag.** `IMAGINE_AUTH_ENABLED`
gates the whole `IMAGINE_AUTH_*` block, because ADR 0017 makes a half-configured
server a startup error and because until #44's registration exists there is no
audience to accept. An endpoint that is briefly open is a documented,
deliberate step in the runbook, not an accident.

**#44 is a hook, not Bicep, and it is opt-in.** App registration is a Graph
operation on a directory object; Bicep cannot express it. `azd`'s
`postprovision` hook runs `infra/hooks/postprovision-entra.ps1`, which creates
or reuses a single-tenant registration, sets both `api://<client-id>` and the
exact `https://<fqdn>/mcp` URI, declares the `access_as_user` delegated scope,
pre-authorizes VS Code, and writes the ids back with `azd env set`. A `predown`
hook deletes it again, because `azd down` would not.

It is gated on `IMAGINE_ENTRA_HOOK=true` and marked `continueOnError`. Creating
app registrations is a tenant permission, admin consent is another, and neither
is something azd can grant itself; in a corporate tenant the operator has
neither. A template whose default path fails for the common case is a bad
template, so the default path skips the hook and the runbook carries the manual
registration whose ids are fed in as `azd env` values.

## Consequences

`azd up` with nothing configured produces a reachable, unauthenticated endpoint
running the published image with no provider key — deliberately the state issue
#40 describes, and three documented flags away from the finished one:
`IMAGINE_OPENROUTER_SECRET_IN_VAULT`, `IMAGINE_ENTRA_HOOK`,
`IMAGINE_AUTH_ENABLED`.

Nothing in the config vocabulary moved. `providers.openrouter.api_key_env` still
names an environment variable and a Key Vault reference is how that variable
gets a value — the ADR 0004 payoff, collected without a line of `src/` changing.

None of this has been run against a live subscription. `az bicep build` passes
on both files and the hooks parse, which catches syntax and type errors and
nothing else. The list of things to correct on first real execution is at the
bottom of `docs/deploy/azure-wizard.md`.

