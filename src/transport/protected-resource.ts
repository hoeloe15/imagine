/**
 * OAuth 2.0 Protected Resource Metadata (RFC 9728) — the document that tells a
 * Claude client where to go and get a token, and the URL that points at it.
 *
 * The MCP authorization spec requires an MCP server to publish this. Without
 * it the hosted Claude surfaces never learn which authorization server to use
 * and report nothing more useful than "Couldn't reach the MCP server". See ADR
 * 0021, and `docs/research/remote-mcp-2026-08.md` §3.2 for the contract.
 *
 * Nothing here reads the `Host` header. Behind Container Apps ingress the host
 * a request arrives with is the platform's, not the one the operator typed into
 * their client, and `resource` has to be the latter exactly.
 */

import type { AuthSettings } from "./auth.js";
import type { Env } from "../core/config.js";

export const PROTECTED_RESOURCE_PATH = "/.well-known/oauth-protected-resource";

/** RFC 9728 §2, restricted to the members this server can honestly claim. */
export interface ProtectedResourceMetadata {
  resource: string;
  authorization_servers: readonly string[];
  scopes_supported: readonly string[];
  bearer_methods_supported: readonly string[];
  resource_name: string;
}

export interface ProtectedResource {
  /** The MCP endpoint URL, canonical, exactly as a client must type it. */
  resource: string;
  /** Absolute URL of the metadata document; what the 401 points at. */
  metadataUrl: string;
  /** Every path this document is served on, longest-lived first. */
  paths: readonly string[];
  document: ProtectedResourceMetadata;
}

/**
 * Canonical form, per RFC 8707 and the MCP spec: lower-cased scheme and host,
 * no default port, no query, no fragment, no trailing slash, path kept. The
 * path is the part that must survive — Claude sends the whole MCP URL as the
 * RFC 8707 `resource`, and a token minted for a different string is a token
 * this server refuses.
 */
export function canonicalResourceUrl(raw: string): string {
  const trimmed = raw.trim();

  let url: URL;
  try {
    url = new URL(trimmed);
  } catch {
    throw new Error(
      `${JSON.stringify(raw)} is not an absolute URL. It must be the full public URL of this server, scheme included.`,
    );
  }

  if (url.protocol !== "https:" && url.protocol !== "http:") {
    throw new Error(
      `${JSON.stringify(raw)} is not an http or https URL, so it cannot be an MCP endpoint.`,
    );
  }

  const path = url.pathname.replace(/\/+$/, "");
  return `${url.protocol}//${url.host}${path}`;
}

/**
 * The metadata URL for a resource, by RFC 9728's path-insertion rule: the
 * well-known segment goes between the origin and the resource's own path. A
 * client probing an MCP endpoint at `/mcp` asks for
 * `/.well-known/oauth-protected-resource/mcp` first, so that spelling is the
 * one the challenge names.
 */
export function metadataUrlFor(resource: string): string {
  const url = new URL(canonicalResourceUrl(resource));
  return `${url.protocol}//${url.host}${PROTECTED_RESOURCE_PATH}${url.pathname.replace(/\/+$/, "")}`;
}

export function protectedResourceFor(
  resource: string,
  auth: AuthSettings,
): ProtectedResource {
  const canonical = canonicalResourceUrl(resource);
  const suffixed = new URL(canonical).pathname.replace(/\/+$/, "");

  return Object.freeze({
    resource: canonical,
    metadataUrl: metadataUrlFor(canonical),
    // Both spellings, because clients differ on which they probe and RFC 9728
    // blesses the bare one while the MCP clients reach for the suffixed one.
    paths: Object.freeze(
      suffixed === ""
        ? [PROTECTED_RESOURCE_PATH]
        : [`${PROTECTED_RESOURCE_PATH}${suffixed}`, PROTECTED_RESOURCE_PATH],
    ),
    document: Object.freeze({
      resource: canonical,
      // Claude uses the first entry and does not fall back to later ones, so
      // there is exactly one: the tenant's v2.0 issuer, which serves OpenID
      // Connect discovery at its own well-known path.
      authorization_servers: Object.freeze([auth.issuer]),
      scopes_supported: Object.freeze([...auth.requiredScopes]),
      bearer_methods_supported: Object.freeze(["header"]),
      resource_name: "imagine",
    }),
  });
}

export interface ProtectedResourceOptions {
  /** The path this server serves MCP on, appended to a bare public base URL. */
  mcpPath: string;
}

/**
 * Where the resource URL comes from, in order:
 *
 * 1. `IMAGINE_MCP_RESOURCE_URI` — the whole endpoint URL, for a deployment
 *    behind a proxy that rewrites the path.
 * 2. `IMAGINE_PUBLIC_URL` — the public origin, with the MCP path appended.
 * 3. the first configured audience that is an http(s) URL, which is the MCP
 *    endpoint URL by construction: ADR 0017 requires the endpoint itself to be
 *    an accepted audience, and the azd template puts it first.
 *
 * Returns `null` when authentication is off (there is nothing to advertise) or
 * when none of the three yields a URL, in which case the server keeps working
 * and says on stderr what it could not publish.
 */
export function protectedResourceFromEnv(
  env: Env,
  auth: AuthSettings | null,
  options: ProtectedResourceOptions,
): ProtectedResource | null {
  if (auth === null) return null;

  const explicit = env.IMAGINE_MCP_RESOURCE_URI?.trim();
  if (explicit) return protectedResourceFor(explicit, auth);

  const base = env.IMAGINE_PUBLIC_URL?.trim();
  if (base) {
    return protectedResourceFor(`${base.replace(/\/+$/, "")}${options.mcpPath}`, auth);
  }

  const audience = auth.audiences.find((value) => /^https?:\/\//i.test(value));
  return audience === undefined ? null : protectedResourceFor(audience, auth);
}
