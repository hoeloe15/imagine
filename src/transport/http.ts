/**
 * Streamable HTTP for the handshake era (protocol revisions 2025-03-26 …
 * 2025-11-25), which is what Claude clients demonstrably speak today. The
 * 2026-07-28 modern era removes the handshake, sessions and the GET stream; it
 * is deliberately not served here. When it lands (issue #46) it belongs beside
 * `handleMcpPost` as a second handler chosen by the route table below — not as
 * a rewrite of this module. See ADR 0016 and
 * `docs/research/remote-mcp-2026-08.md` §1.
 */

import {
  createServer as createNodeHttpServer,
  type IncomingMessage,
  type ServerResponse,
} from "node:http";
import type { AddressInfo } from "node:net";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import type { Env } from "../core/config.js";
import { version } from "../version.js";
import {
  bearerChallenge,
  type Authenticator,
  type Authoriser,
  type CallerIdentity,
} from "./auth.js";
import type { ProtectedResource } from "./protected-resource.js";

export const MCP_PATH = "/mcp";
export const HEALTH_PATH = "/healthz";
export const DEFAULT_HTTP_HOST = "127.0.0.1";
export const DEFAULT_HTTP_PORT = 3000;

export interface HttpSettings {
  host: string;
  port: number;
  allowedOrigins: readonly string[];
}

/**
 * What the transport knows about one request by the time a tool could run.
 * `caller` is `null` exactly when no authenticator is configured. Issue #45
 * consumes it to key the cost ledger and per-caller budgets.
 */
export interface RequestContext {
  caller: CallerIdentity | null;
}

export interface HttpTransportOptions extends Partial<HttpSettings> {
  /**
   * Called once per POST. Request handling is stateless, so every request gets
   * its own `McpServer` over its own transport and nothing survives the
   * response; the dependencies behind it are shared and immutable.
   */
  createServer: (context: RequestContext) => McpServer;
  /**
   * Checks the `Authorization` header before any tool can run. Omitted means
   * the endpoint is open, which is the local mode.
   */
  authenticate?: Authenticator;
  /**
   * Decides whether the authenticated caller is welcome, after the token has
   * been verified. Omitted means everyone the issuer accepts is welcome, which
   * is what a deployment without an allowlist has always done. The portal calls
   * the same seam with the identity it read from a session cookie.
   */
  authorise?: Authoriser;
  /**
   * The RFC 9728 document to serve, and the URL the 401 points at. Present
   * exactly when authentication is configured and a public URL for this server
   * is known; without it the well-known paths are not routes at all.
   */
  protectedResource?: ProtectedResource;
  /**
   * Extra `WWW-Authenticate` parameters on a 401. Defaults to the
   * `resource_metadata` and `scope` derived from {@link protectedResource};
   * passing it explicitly replaces that.
   */
  challengeParams?: Readonly<Record<string, string>>;
}

export interface RunningHttpServer {
  host: string;
  port: number;
  endpoint: string;
  health: string;
  close(): Promise<void>;
}

export function httpRequested(argv: readonly string[], env: Env): boolean {
  return argv.includes("--http") || env.IMAGINE_TRANSPORT?.toLowerCase() === "http";
}

export function httpSettingsFromEnv(env: Env): HttpSettings {
  return {
    host: env.IMAGINE_HTTP_HOST?.trim() || DEFAULT_HTTP_HOST,
    port: parsePort(env.IMAGINE_HTTP_PORT),
    allowedOrigins: parseOrigins(env.IMAGINE_HTTP_ALLOWED_ORIGINS),
  };
}

function parsePort(raw: string | undefined): number {
  if (raw === undefined || raw.trim() === "") return DEFAULT_HTTP_PORT;

  const port = Number(raw.trim());
  if (!Number.isInteger(port) || port < 0 || port > 65535) {
    throw new Error(
      `IMAGINE_HTTP_PORT must be an integer between 0 and 65535, not ${JSON.stringify(raw)}.`,
    );
  }
  return port;
}

function parseOrigins(raw: string | undefined): readonly string[] {
  return (raw ?? "")
    .split(",")
    .map((entry) => entry.trim())
    .filter((entry) => entry !== "");
}

/**
 * DNS rebinding is the attack this closes: a page on a hostname the attacker
 * controls, re-resolved to a loopback address, POSTing to a local server. Such
 * a request carries the attacker's `Origin`, so anything that is neither
 * same-origin, loopback nor explicitly allowed is refused. A request with no
 * `Origin` at all is not a browser and is left alone.
 */
export function isOriginAllowed(
  origin: string | undefined,
  hostHeader: string | undefined,
  allowed: readonly string[],
): boolean {
  if (origin === undefined || origin === "") return true;
  if (allowed.includes("*") || allowed.includes(origin)) return true;

  let parsed: URL;
  try {
    parsed = new URL(origin);
  } catch {
    return false;
  }

  if (
    hostHeader !== undefined &&
    parsed.host.toLowerCase() === hostHeader.toLowerCase()
  ) {
    return true;
  }

  return isLoopbackHostname(parsed.hostname);
}

function isLoopbackHostname(hostname: string): boolean {
  const bare = hostname.replace(/^\[|\]$/g, "").toLowerCase();
  return bare === "localhost" || bare === "::1" || /^127\.\d+\.\d+\.\d+$/.test(bare);
}

export async function startHttpServer(
  options: HttpTransportOptions,
): Promise<RunningHttpServer> {
  const host = options.host ?? DEFAULT_HTTP_HOST;
  const requestedPort = options.port ?? DEFAULT_HTTP_PORT;
  const allowedOrigins = options.allowedOrigins ?? [];

  const httpServer = createNodeHttpServer((req, res) => {
    void route(req, res, options, allowedOrigins);
  });

  const port = await listen(httpServer, host, requestedPort);
  const base = `http://${formatAuthority(host, port)}`;

  return {
    host,
    port,
    endpoint: `${base}${MCP_PATH}`,
    health: `${base}${HEALTH_PATH}`,
    close: () =>
      new Promise<void>((resolve, reject) => {
        httpServer.closeAllConnections();
        httpServer.close((error) => (error ? reject(error) : resolve()));
      }),
  };
}

function listen(
  httpServer: ReturnType<typeof createNodeHttpServer>,
  host: string,
  port: number,
): Promise<number> {
  return new Promise((resolve, reject) => {
    httpServer.once("error", reject);
    httpServer.listen(port, host, () => {
      httpServer.removeListener("error", reject);
      resolve((httpServer.address() as AddressInfo).port);
    });
  });
}

function formatAuthority(host: string, port: number): string {
  const display = host === "0.0.0.0" || host === "::" ? DEFAULT_HTTP_HOST : host;
  return display.includes(":") ? `[${display}]:${port}` : `${display}:${port}`;
}

async function route(
  req: IncomingMessage,
  res: ServerResponse,
  options: HttpTransportOptions,
  allowedOrigins: readonly string[],
): Promise<void> {
  try {
    const path = new URL(req.url ?? "/", "http://placeholder").pathname;

    if (path === HEALTH_PATH) {
      handleHealth(req, res);
      return;
    }

    // Before the origin check and before authentication, deliberately: a
    // client that cannot read this document has no way to learn how to
    // authenticate, so guarding it would close the only door out of the 401.
    if (options.protectedResource?.paths.includes(path)) {
      handleProtectedResource(req, res, options.protectedResource);
      return;
    }

    if (path !== MCP_PATH) {
      sendJson(res, 404, { error: notFoundMessage(options) });
      return;
    }

    if (!isOriginAllowed(header(req, "origin"), header(req, "host"), allowedOrigins)) {
      sendRpcError(
        res,
        403,
        -32600,
        "Origin not allowed. Add it to IMAGINE_HTTP_ALLOWED_ORIGINS (comma separated) to permit it.",
      );
      return;
    }

    if (req.method !== "POST") {
      res.setHeader("Allow", "POST");
      sendRpcError(
        res,
        405,
        -32600,
        `${MCP_PATH} accepts JSON-RPC over POST only. Health probes belong on ${HEALTH_PATH}.`,
      );
      return;
    }

    const caller = await authenticated(req, res, options);
    if (caller === REFUSED) return;
    if (!allowed(caller, res, options)) return;

    await handleMcpPost(req, res, () => options.createServer({ caller }));
  } catch (error) {
    if (!res.headersSent) {
      sendRpcError(res, 500, -32603, `Internal server error: ${describe(error)}`);
      return;
    }
    res.end();
  }
}

function notFoundMessage(options: HttpTransportOptions): string {
  const paths = [MCP_PATH, HEALTH_PATH, ...(options.protectedResource?.paths ?? [])];
  return `Not found. This server serves ${paths.join(", ")}.`;
}

function handleProtectedResource(
  req: IncomingMessage,
  res: ServerResponse,
  resource: ProtectedResource,
): void {
  if (req.method !== "GET" && req.method !== "HEAD") {
    res.setHeader("Allow", "GET, HEAD");
    sendJson(res, 405, { error: "The metadata document is read with GET." });
    return;
  }

  res.setHeader("cache-control", "no-store");
  sendJson(res, 200, resource.document);
}

function handleHealth(req: IncomingMessage, res: ServerResponse): void {
  if (req.method !== "GET" && req.method !== "HEAD") {
    res.setHeader("Allow", "GET, HEAD");
    sendJson(res, 405, { error: `${HEALTH_PATH} accepts GET.` });
    return;
  }
  sendJson(res, 200, { status: "ok", name: "imagine", version });
}

const REFUSED = Symbol("refused");

/**
 * An authentication failure is a transport-level status with a challenge, never
 * a tool-level error envelope: the client has to see a 401 to know it should go
 * and get a token.
 */
async function authenticated(
  req: IncomingMessage,
  res: ServerResponse,
  options: HttpTransportOptions,
): Promise<CallerIdentity | null | typeof REFUSED> {
  if (!options.authenticate) return null;

  const outcome = await options.authenticate(header(req, "authorization"));
  if (outcome.ok) return outcome.caller;

  res.setHeader(
    "WWW-Authenticate",
    bearerChallenge(outcome, challengeParams(options, outcome.status)),
  );
  sendRpcError(res, outcome.status, -32600, outcome.message);
  return REFUSED;
}

/**
 * Membership, checked after the token was verified. The refusal carries no
 * `WWW-Authenticate` at all — not even a bare challenge — because the token is
 * genuine and there is no credential the caller could go and fetch that would
 * change the answer. This is ADR 0021's treatment of `insufficient_scope`
 * carried one step further: that 403 keeps its challenge because a differently
 * scoped token exists; this one has nothing honest to point at.
 */
function allowed(
  caller: CallerIdentity | null,
  res: ServerResponse,
  options: HttpTransportOptions,
): boolean {
  if (caller === null || !options.authorise) return true;

  const decision = options.authorise(caller);
  if (decision.ok) return true;

  sendRpcError(res, decision.status, -32600, decision.message);
  return false;
}

/**
 * The pointer rides on the 401 and on nothing else. A 403 means the caller is
 * authenticated and a fresh login would not help, and a 503 means this server
 * could not reach the tenant's keys — sending either client off to start OAuth
 * would be a lie that costs it a round trip and a consent screen.
 */
function challengeParams(
  options: HttpTransportOptions,
  status: number,
): Readonly<Record<string, string>> | undefined {
  if (status !== 401) return undefined;
  if (options.challengeParams) return options.challengeParams;
  if (!options.protectedResource) return undefined;

  const scopes = options.protectedResource.document.scopes_supported ?? [];

  return {
    resource_metadata: options.protectedResource.metadataUrl,
    ...(scopes.length > 0 ? { scope: scopes.join(" ") } : {}),
  };
}

async function handleMcpPost(
  req: IncomingMessage,
  res: ServerResponse,
  createServer: () => McpServer,
): Promise<void> {
  const server = createServer();
  const transport = new StreamableHTTPServerTransport({
    sessionIdGenerator: undefined,
  });

  res.on("close", () => {
    void transport.close();
    void server.close();
  });

  await server.connect(transport);
  await transport.handleRequest(req, res);
}

function header(req: IncomingMessage, name: string): string | undefined {
  const value = req.headers[name];
  return Array.isArray(value) ? value[0] : value;
}

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  const payload = JSON.stringify(body);
  res.writeHead(status, {
    "content-type": "application/json",
    "content-length": Buffer.byteLength(payload),
  });
  res.end(payload);
}

function sendRpcError(
  res: ServerResponse,
  status: number,
  code: number,
  message: string,
): void {
  sendJson(res, status, { jsonrpc: "2.0", id: null, error: { code, message } });
}

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
