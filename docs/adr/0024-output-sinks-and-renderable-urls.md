# 24. Output sinks and renderable URLs

**Status:** accepted
**Date:** 2026-09-04
**Follows:** [ADR 0003](0003-normalised-seam-types.md),
[ADR 0006](0006-output-writing-naming-and-the-manifest.md),
[ADR 0020](0020-the-azd-template.md),
[ADR 0022](0022-hosted-config-and-managed-identity.md)

## Context

A hosted chat client generated an image successfully and then showed a broken
picture. The tool had done everything right: it wrote the file and answered
`path: /app/imagine-output/a-lighthouse-...png`. But that path names a directory
inside a container the client cannot reach, on a disk that is emptied on the
next revision. The one thing the user wanted — to see the image — was the one
thing the result could not deliver.

The constraint that caused it is deliberate and is not moving: image bytes never
travel back through the tool result (PLAN.md §4.2, ADR 0010). A base64 payload
in a tool result is a model's whole context spent on pixels it cannot look at.

So the answer is not "send the bytes", it is "store them somewhere the client
can fetch them from, and hand back a link".

## Decision

### A sink is a seam, not a rewrite of `output.ts`

`core/output.ts` stays the only place that turns bytes into a stored image, and
it keeps every rule ADR 0006 set: the `{slug}-{hash}.{ext}` template, the slug
alphabet that stops traversal, the never-overwrite rule, the manifest line. What
moved out is the last three lines — the part that actually touches a disk.

```ts
interface ObjectSink {
  put(filename: string, bytes: Uint8Array, mimeType: string): Promise<StoredImage>;
}
interface StoredImage {
  path: string;
  url?: string;
}
```

`writeImage(request, result, config, sink?)` renders the filename, hands it to
the sink, and appends the manifest line. **No sink means the local filesystem**,
which is exactly the code that was already there — so local mode is not a
"local sink" that has to be kept in step with the old behaviour, it *is* the old
behaviour, and every existing output test passes untouched.

The alternative was a sink object for the filesystem too, for symmetry. That
would have made the common case pay for the rare one: directory resolution,
`output_dir` and `mkdir` are filesystem concepts that a blob container has no
analogue for, and pushing them behind the interface would have forced the blob
sink to implement or stub three things it does not have.

`generate_image` stays thin. It calls one writer and gets back
`{ path, url?, manifest_path }`.

### `path` keeps its meaning; `url` is a new, optional field

Issue #42 proposed making `path` a URL in blob mode. The live symptom argues
against it: what the client needs is not a renamed `path`, it is *an extra thing
it can fetch*. So `path` is where the image is (a filesystem path locally, the
blob's own URL hosted) and `url` is a link that needs no credentials. Local mode
returns no `url` at all, which is honest — there is no link, and an empty string
would be a client bug waiting to happen.

The tool description tells the calling model to show `url` when it is there.

### The link is a user delegation SAS, scoped to one blob

The URL has to work in a client that has no Azure credentials, and it must not
be a permanent public handle to everyone's images.

A **user delegation SAS** is signed with a key the storage account issues to the
container's managed identity, so no account key exists anywhere — the same
property that made ADR 0022's keyless Azure OpenAI route worth having. It is
scoped with `sr=b` to the single blob, never to the container: a container-wide
token would turn one leaked URL into a key to everybody's pictures. It carries
`sp=r`, `spr=https` and an expiry of `output.blob.url_ttl_hours` (default one
hour).

Two REST calls and one HMAC, over plain `fetch`:

- `POST <account>/?restype=service&comp=userdelegationkey` with the identity's
  bearer token returns a `UserDelegationKey`. The key is cached for its lifetime
  minus ten minutes, and concurrent callers share one in-flight request — the
  same shape as the token cache in ADR 0022.
- `PUT <account>/<container>/<name>` with `x-ms-blob-type: BlockBlob` uploads.

**No `@azure/storage-blob`.** This is ADR 0022's argument again, and it comes out
the same way: what is needed is one PUT, one POST and an HMAC that Node's own
`crypto` computes. Against that sits a large transitive tree on a package with
two runtime dependencies. The one thing that *is* genuinely delicate — the
string-to-sign — is delicate in a way a library would not save us from
debugging, because a mistake there is a 403 with no detail.

**The string-to-sign is verified against the docs and pinned by a test.** It was
read from `create-user-delegation-sas` on Microsoft Learn, not from memory: at
service version `2020-12-06` it is twenty-four fields joined by newlines, with
`saoid`, `suoid`, `scid`, `sip`, the snapshot time, `ses` and the five `rsc*`
overrides present as **empty lines**. A missing empty line is a signature that
never validates and an error message that says nothing. So `sv` and the
`x-ms-version` header are one constant, the field order lives in one function,
and a unit test asserts the exact string plus a frozen signature over a fixed
key. Microsoft publishes no signed example to check against — the vector in the
test is our own, and it is a regression pin rather than an independent proof.

**The public-container fallback was not needed.** Signing turned out to be
tractable, so the account keeps `allowBlobPublicAccess: false`. Had it not been,
the fallback would have been a container whose blobs are world-readable, and it
is worth naming what that would have cost: every generated image permanently
readable by anyone who guesses or is shown a URL, with no expiry and no way to
revoke short of deleting the blob. That is a materially worse privacy position
and it is not on the table while the SAS works.

### Collisions are the service's decision

The upload sends `If-None-Match: *`, so the *service* refuses to overwrite. A
409 or 412 moves on to `<stem>-2<suffix>`, exactly as `EEXIST` does locally.
This is the blob analogue of ADR 0006's atomic `wx` open, and for the same
reason: a read-then-write would leave a window in which two concurrent
generations pick the same name.

### The manifest and the cost log stay local, for now

Both are still written to the container filesystem, which means a hosted
manifest is emptied on every revision. That is a real gap and it is written down
rather than papered over: the manifest is the gallery's index, and moving it is
issue #45's job (with #17's gallery). Doing it here would mean inventing an
append protocol over blobs — read-modify-write, or one blob per record, or a
lease — which is a design, not a detail. The manifest line does now carry the
`url` next to the `path`, so nothing is lost when the store moves.

### Configuration: one section, two ways in

```json
{
  "output": {
    "sink": "blob",
    "blob": {
      "account_url": "https://stabc123.blob.core.windows.net",
      "container": "images",
      "url_ttl_hours": 1
    }
  }
}
```

`sink` defaults to `"local"` and `blob` to `null`; asking for `"blob"` without a
`blob` section is a validation error naming `output.blob`. `url_ttl_hours` is
capped at 168, because a user delegation key cannot outlive seven days.

Hosted, the account URL and container only exist *after* the storage account
does, so the template fills them in through three dedicated variables —
`IMAGINE_OUTPUT_SINK`, `IMAGINE_OUTPUT_BLOB_ACCOUNT_URL`,
`IMAGINE_OUTPUT_BLOB_CONTAINER` (and the optional
`IMAGINE_OUTPUT_BLOB_URL_TTL_HOURS`) — rather than making the operator paste
generated values into `IMAGINE_CONFIG_JSON` by hand.

This is a deliberate exception to ADR 0022's "no per-field environment
variables", and it is narrow: these four exist because their values are
*generated by the deployment*, not typed by a person. They are turned into an
ordinary `output` fragment and run through `configFileSchema` like every other
fragment, so a typo is the same error it would be in a file, labelled `the
IMAGINE_OUTPUT_* environment variables`.

**Precedence, least to most specific:** bundled defaults, `~/.imagine/config.json`,
`./config.json`, `IMAGINE_OUTPUT_*`, `IMAGINE_CONFIG_JSON`. The dedicated
variables sit *below* `IMAGINE_CONFIG_JSON` because they are filled in
automatically and it is typed on purpose; an operator who writes an `output`
section by hand meant it.

### Bicep: opt in, and two role assignments, not one

`azd env set IMAGINE_OUTPUT_SINK blob` provisions a StorageV2 account (HTTPS
only, TLS 1.2 minimum, `allowBlobPublicAccess: false`, `allowSharedKeyAccess:
false`, `defaultToOAuthAuthentication: true`), one container, and the two role
assignments the identity needs:

- **Storage Blob Data Contributor, `ba92f5b4-2d11-453d-a403-e96b0029c9fe`**,
  scoped to the container — write the blob.
- **Storage Blob Delegator, `db58b8e5-c6ad-4a2a-8342-4190687cbf4a`**, scoped to
  the **storage account** — sign the link.

Both GUIDs were read from the live tenant with
`az role definition list --name "<role>" --query "[].name" -o tsv`, not from
memory, for the reason ADR 0022 gives (commit 911edea shipped an invented one).

The delegator scope is not a slip. `Get User Delegation Key` documents
`generateUserDelegationKey` as an account-level action: scoped to the container
it would parse, deploy, and then fail every link request with a 403. That is
exactly the kind of bug that looks like a signing error and is not.

Default is `local`, so an existing deployment provisions nothing new until it
asks to. `MCP_OUTPUT_BLOB_URL` names the container, and the postdeploy hook says
which sink is live and how to switch.

## Consequences

A hosted `generate_image` now answers with a link the client renders, and the
bytes still never cross the tool boundary. Storage costs a few cents a month for
this volume; the images accumulate with no lifecycle rule, which is #45's
problem along with the manifest.

The `sv=2020-12-06` string-to-sign is a contract with a documented service
version. Later versions add fields (`skdutid`, `sduoid` at 2025-07-05; `srh`,
`srq` at 2026-04-06) *in the middle* of the string, so bumping the version means
changing the field list, not just the constant. The test pins the current layout
so that a bump cannot be silent.

Role assignment propagation is eventually consistent, so the first call after the
`azd up` that turns the sink on can 403 and then succeed a minute later. That is the
same caveat ADR 0022 recorded and it is in the runbook rather than engineered
around.

None of this has run against a live storage account. `az bicep build` passes,
the sink is covered by unit tests with an injected `fetch`, and the first-run
checklist is in `docs/deploy/azure-wizard.md`.

## Amendment, 2026-09-04: a link is not the same as a picture

The sink shipped and worked — and the user still did not see the image. In a
hosted chat client the model got `path` and `url` back, printed the URL as a
plain link, said it could not display images, and volunteered that the link was
"valid for 24 hours", a number nothing in the result had told it. Two separate
gaps: the envelope never said *how* to present the link, and it never said when
the link dies, so the model filled the silence in.

Both are now answered in the result rather than in a runbook:

- **`url_expires_at`** is the ISO 8601 moment the link stops working, present
  exactly when `url` is. It is the `se` field of the signature itself, so the
  envelope and the token cannot drift apart, and a model that would otherwise
  guess has the real answer to hand. Local mode has no link and therefore no
  expiry — the field is absent, not empty, for the same reason `url` is.
- **A rendering hint**, as a second text content item, telling the model to
  write `![alt](url)`, to quote that expiry and no other, and not to fetch or
  re-encode the bytes. It is stated to the model because the model is what
  decides how the answer is rendered; a schema description alone was not enough,
  as the observed behaviour shows.
- **A `resource_link` content item**, which the installed MCP SDK supports, is
  emitted alongside it and is the preferred path: a client that understands
  `resource_link` renders the image without any instruction at all. The text
  hint exists for the clients that do not, so both ship together rather than one
  replacing the other.

The JSON envelope stays the first content item and stays untouched, because it
is what clients and tests parse. Nothing here weakens PLAN.md §4.2: what crosses
the boundary is still a link, a filename and a sentence, never a byte of image.
