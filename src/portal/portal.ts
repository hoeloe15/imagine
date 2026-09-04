/**
 * The portal's route family, behind one factory that takes the same core
 * dependencies the MCP server gets — which is what keeps splitting it into a
 * second container app (#47) a day of infrastructure work rather than a
 * rewrite.
 *
 * The separation from `/mcp` is the point and it is absolute:
 *
 * - `/mcp` reads `Authorization` and **ignores cookies entirely**.
 * - `/portal/*` reads the session cookie and **ignores `Authorization`
 *   entirely**.
 *
 * So a browser session can never make a tool call cross-site, and a leaked
 * bearer token can never write a secret. Both ask the same
 * {@link Authoriser} whether the person behind the credential is welcome, so
 * the allowlist of ADR 0025 covers the page as well as the endpoint.
 *
 * No route returns a secret value in any shape. The key field is write-only and
 * the page reports presence, source and the *name* of the vault secret — no
 * last four, no length, no preview.
 */

import type { IncomingMessage, ServerResponse } from "node:http";
import type { Config } from "../core/config-schema.js";
import {
  secretNameFor,
  type SecretResolver,
  type WritableSecretStore,
} from "../core/secrets.js";
import type { AuthSettings, Authenticator, Authoriser } from "../transport/auth.js";
import {
  auditRecord,
  createAuditLog,
  type AuditAction,
  type AuditLog,
} from "./audit.js";
import {
  authorizeUrl,
  createPkcePair,
  createState,
  exchangeCode,
  identityFrom,
  LoginFailed,
  logoutUrl,
  type FetchLike,
  type PortalIdentity,
} from "./login.js";
import {
  dashboardPage,
  loginPage,
  messagePage,
  STYLESHEET,
  type ProviderStatus,
  type ProviderView,
} from "./pages.js";
import {
  clearedCookie,
  cookie,
  csrfToken,
  equal,
  parseCookies,
  readLoginState,
  readSession,
  seal,
  sessionKey,
  CSRF_FIELD,
  SESSION_COOKIE,
  STATE_COOKIE,
  type PortalSession,
} from "./session.js";
import {
  PORTAL_CALLBACK_PATH,
  PORTAL_KEYS_PREFIX,
  PORTAL_LOGIN_PATH,
  PORTAL_LOGOUT_PATH,
  PORTAL_PATH,
  PORTAL_STYLE_PATH,
  type PortalSettings,
} from "./settings.js";

/** The shape `src/transport/http.ts` mounts, and all it knows about the portal. */
export interface PathHandler {
  handles(path: string): boolean;
  handle(req: IncomingMessage, res: ServerResponse): Promise<void>;
}

export interface PortalOptions {
  settings: PortalSettings;
  config: Config;
  secrets: SecretResolver;
  auth: AuthSettings;
  /** The vault, when one is configured. Without it no key can be saved. */
  vault?: WritableSecretStore;
  /** The same authenticator `/mcp` uses, for the token the exchange returns. */
  authenticate?: Authenticator;
  /** The same membership check `/mcp` applies, applied to portal logins too. */
  authorise?: Authoriser;
  audit?: AuditLog;
  fetch?: FetchLike;
  now?: () => Date;
}

/** No inline anything, no external origin, and nothing may frame this page. */
const CONTENT_SECURITY_POLICY = [
  "default-src 'none'",
  "style-src 'self'",
  "img-src 'self'",
  "form-action 'self'",
  "base-uri 'none'",
  "frame-ancestors 'none'",
].join("; ");

const MAX_BODY_BYTES = 8192;
const MIN_KEY_LENGTH = 8;
const MAX_KEY_LENGTH = 4096;

export function createPortal(options: PortalOptions): PathHandler {
  const { settings, config, secrets } = options;
  const key = sessionKey(settings.sessionSecret);
  const audit = options.audit ?? createAuditLog({ costLog: config.logging.cost_log });
  const clock = options.now ?? (() => new Date());
  const seconds = (): number => Math.floor(clock().getTime() / 1000);

  function providerIds(): string[] {
    return Object.keys(config.providers);
  }

  async function providerViews(): Promise<ProviderView[]> {
    return Promise.all(providerIds().map((id) => providerView(id)));
  }

  async function providerView(id: string): Promise<ProviderView> {
    const provider = config.providers[id];
    const secretName = provider === undefined ? null : secretNameFor(provider);
    const envVar = provider?.api_key_env ?? null;

    if (provider === undefined || !provider.enabled) {
      return {
        id,
        status: "disabled",
        keySource: null,
        secretName,
        envVar,
        writable: false,
        note: "Disabled in configuration. Enable it there before a key here would do anything.",
      };
    }

    if (provider.auth === "entra") {
      return {
        id,
        status: "ready",
        keySource: null,
        secretName,
        envVar,
        writable: false,
        note: "Authenticates with the deployment's own managed identity, so there is no key to set.",
      };
    }

    const lookup = await secrets.lookup(id);
    const status: ProviderStatus =
      lookup.resolution === null ? "not_configured" : "ready";
    const writable = options.vault !== undefined && secretName !== null;

    return {
      id,
      status,
      keySource: lookup.resolution?.source ?? null,
      secretName,
      envVar,
      writable,
      note: lookup.note ?? null,
    };
  }

  function vaultNote(): string | null {
    if (options.vault !== undefined) return null;
    return "No Key Vault is configured for this server, so keys cannot be saved from this page. Set IMAGINE_KEY_VAULT_URL and give the container identity Key Vault Secrets Officer on the vault.";
  }

  function session(req: IncomingMessage): PortalSession | null {
    const jar = parseCookies(header(req, "cookie"));
    return readSession(key, jar.get(SESSION_COOKIE), seconds());
  }

  async function handleIndex(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const current = session(req);
    if (current === null) {
      send(res, 200, "text/html; charset=utf-8", loginPage(), req);
      return;
    }

    const providers = await providerViews();
    const query = new URL(req.url ?? "/", "http://placeholder").searchParams;

    send(
      res,
      200,
      "text/html; charset=utf-8",
      dashboardPage({
        email: current.email,
        name: current.name,
        subject: current.subject,
        csrf: csrfToken(key, current),
        providers,
        flash: flashFor(query, providers),
        vaultNote: vaultNote(),
      }),
      req,
    );
  }

  function handleLogin(req: IncomingMessage, res: ServerResponse): void {
    if (!secureEnough(req)) {
      send(res, 400, "text/html; charset=utf-8", insecurePage(), req);
      return;
    }

    const pkce = createPkcePair();
    const state = createState();
    const sealed = seal(key, {
      state,
      verifier: pkce.verifier,
      exp: seconds() + settings.loginWindowSeconds,
    });

    res.setHeader(
      "set-cookie",
      cookie(STATE_COOKIE, sealed, {
        maxAgeSeconds: settings.loginWindowSeconds,
        secure: isHttps(req),
        path: PORTAL_PATH,
      }),
    );
    redirect(res, authorizeUrl(settings, state, pkce.challenge), req);
  }

  async function handleCallback(
    req: IncomingMessage,
    res: ServerResponse,
  ): Promise<void> {
    const url = new URL(req.url ?? "/", "http://placeholder");
    const jar = parseCookies(header(req, "cookie"));
    const pending = readLoginState(key, jar.get(STATE_COOKIE), seconds());

    // Dropped whatever happens next: a state cookie is good for one attempt.
    const drop = clearedCookie(STATE_COOKIE, PORTAL_PATH, isHttps(req));

    const returned = url.searchParams.get("state");
    if (pending === null || returned === null || !equal(pending.state, returned)) {
      res.setHeader("set-cookie", drop);
      send(
        res,
        400,
        "text/html; charset=utf-8",
        messagePage(
          "That login could not be matched",
          "The one-time value this server sent to the login page did not come back with it. That happens when a login is left open too long, or when the link was not the one this browser started. Start again from the portal.",
        ),
        req,
      );
      return;
    }

    const description = url.searchParams.get("error_description");
    const error = url.searchParams.get("error");
    if (error !== null) {
      res.setHeader("set-cookie", drop);
      send(
        res,
        400,
        "text/html; charset=utf-8",
        messagePage("The login was refused", description ?? error),
        req,
      );
      return;
    }

    const code = url.searchParams.get("code");
    if (code === null) {
      res.setHeader("set-cookie", drop);
      send(
        res,
        400,
        "text/html; charset=utf-8",
        messagePage(
          "That login came back incomplete",
          "The authorization server sent this browser back without an authorization code. Start again from the portal.",
        ),
        req,
      );
      return;
    }

    let identity: PortalIdentity;
    try {
      const result = await exchangeCode({
        settings,
        code,
        verifier: pending.verifier,
        clientSecret: await clientSecret(),
        ...(options.fetch ? { fetch: options.fetch } : {}),
      });
      identity = await identityFrom(result, {
        auth: options.auth,
        ...(options.authenticate ? { authenticate: options.authenticate } : {}),
        nowSeconds: seconds(),
        sessionSeconds: settings.sessionSeconds,
      });
    } catch (cause) {
      res.setHeader("set-cookie", drop);
      send(
        res,
        502,
        "text/html; charset=utf-8",
        messagePage(
          "The login could not be completed",
          cause instanceof LoginFailed ? cause.message : "The code exchange failed.",
        ),
        req,
      );
      return;
    }

    const decision = options.authorise?.(identity.caller) ?? { ok: true as const };
    if (!decision.ok) {
      res.setHeader("set-cookie", drop);
      send(
        res,
        403,
        "text/html; charset=utf-8",
        messagePage("Not allowed", decision.message),
        req,
      );
      return;
    }

    if (!secureEnough(req)) {
      res.setHeader("set-cookie", drop);
      send(res, 400, "text/html; charset=utf-8", insecurePage(), req);
      return;
    }

    const expiresAt = seconds() + settings.sessionSeconds;
    const sealed = seal(key, {
      callerId: identity.caller.callerId,
      subject: identity.caller.subject,
      email: identity.caller.email,
      name: identity.caller.name,
      sid: identity.sid,
      exp: expiresAt,
    });

    res.setHeader("set-cookie", [
      drop,
      cookie(SESSION_COOKIE, sealed, {
        maxAgeSeconds: settings.sessionSeconds,
        secure: isHttps(req),
        path: PORTAL_PATH,
      }),
    ]);
    redirect(res, PORTAL_PATH, req);
  }

  async function handleLogout(
    req: IncomingMessage,
    res: ServerResponse,
  ): Promise<void> {
    const current = session(req);
    const body = await readForm(req, res);
    if (body === null) return;
    if (!checked(req, res, current, body)) return;

    res.setHeader(
      "set-cookie",
      clearedCookie(SESSION_COOKIE, PORTAL_PATH, isHttps(req)),
    );
    redirect(res, logoutUrl(settings, current?.sid ?? null), req);
  }

  async function handleKeyWrite(
    req: IncomingMessage,
    res: ServerResponse,
    providerId: string,
  ): Promise<void> {
    const current = session(req);
    const body = await readForm(req, res);
    if (body === null) return;
    if (!checked(req, res, current, body)) return;
    if (current === null) return;

    const view = await providerView(providerId);
    if (
      !providerIds().includes(providerId) ||
      !view.writable ||
      view.secretName === null
    ) {
      redirect(res, `${PORTAL_PATH}?failed=${encodeURIComponent(providerId)}`, req);
      return;
    }

    const vault = options.vault;
    if (vault === undefined) {
      redirect(res, `${PORTAL_PATH}?failed=${encodeURIComponent(providerId)}`, req);
      return;
    }

    const clearing = body.get("action") === "clear";
    const action: AuditAction = clearing ? "secret.clear" : "secret.set";

    if (!clearing) {
      const problem = keyProblem(body.get("value") ?? "");
      if (problem !== null) {
        redirect(res, `${PORTAL_PATH}?invalid=${encodeURIComponent(providerId)}`, req);
        return;
      }
    }

    try {
      if (clearing) await vault.remove(view.secretName);
      else await vault.set(view.secretName, (body.get("value") ?? "").trim());

      secrets.invalidate(providerId);
      await audit.write(
        auditRecord(
          {
            caller_id: current.callerId,
            action,
            target: providerId,
            secret_name: view.secretName,
            outcome: "ok",
          },
          clock(),
        ),
      );
      redirect(
        res,
        `${PORTAL_PATH}?${clearing ? "cleared" : "saved"}=${encodeURIComponent(providerId)}`,
        req,
      );
    } catch (cause) {
      await audit.write(
        auditRecord(
          {
            caller_id: current.callerId,
            action,
            target: providerId,
            secret_name: view.secretName,
            outcome: "failed",
            detail: cause instanceof Error ? cause.message : String(cause),
          },
          clock(),
        ),
      );
      redirect(res, `${PORTAL_PATH}?failed=${encodeURIComponent(providerId)}`, req);
    }
  }

  /**
   * The client secret, only if one was deliberately put in the vault. The
   * portal tries PKCE alone first precisely so that this stays `null` — see the
   * argument at the top of `login.ts`.
   */
  async function clientSecret(): Promise<string | null> {
    if (options.vault === undefined) return null;
    try {
      return await options.vault.get(settings.clientSecretName);
    } catch {
      return null;
    }
  }

  /**
   * Every state-changing POST, in one place: a session, an `Origin` this server
   * recognises, a `Sec-Fetch-Site` that is not cross-site, and a CSRF token
   * bound to this session and compared in constant time. `GET` changes nothing,
   * anywhere, so it needs none of this.
   */
  function checked(
    req: IncomingMessage,
    res: ServerResponse,
    current: PortalSession | null,
    body: URLSearchParams,
  ): boolean {
    if (!sameSite(req)) {
      send(
        res,
        403,
        "text/html; charset=utf-8",
        messagePage(
          "That request came from somewhere else",
          "This form was submitted from another site, so it was refused. Open the portal directly and try again.",
        ),
        req,
      );
      return false;
    }

    if (current === null) {
      send(res, 403, "text/html; charset=utf-8", loginPage(), req);
      return false;
    }

    const presented = body.get(CSRF_FIELD) ?? "";
    if (!equal(presented, csrfToken(key, current))) {
      send(
        res,
        403,
        "text/html; charset=utf-8",
        messagePage(
          "That form was out of date",
          "The one-time value in the form did not match this session. Reload the portal and try again.",
        ),
        req,
      );
      return false;
    }

    return true;
  }

  /**
   * A matching `Origin` is the protection; `Sec-Fetch-Site` only backs it up.
   * Browsers differ in what they send on a same-origin form post (some omit
   * `Origin`, some say `same-site` behind an ingress), so either signal alone
   * is accepted when it is unambiguous, and a refusal logs what was seen.
   */
  function sameSite(req: IncomingMessage): boolean {
    const site = header(req, "sec-fetch-site");
    const origin = header(req, "origin");
    const host = header(req, "host");

    if (site === "cross-site") return refuseSite(site, origin, host);

    const acceptable = new Set([new URL(settings.baseUrl).origin]);
    if (host !== undefined) {
      acceptable.add(`https://${host}`);
      acceptable.add(`http://${host}`);
    }

    if (origin !== undefined) {
      return acceptable.has(origin) || refuseSite(site, origin, host);
    }
    return site === "same-origin" || site === "none" || refuseSite(site, origin, host);
  }

  function refuseSite(
    site: string | undefined,
    origin: string | undefined,
    host: string | undefined,
  ): false {
    process.stderr.write(
      `imagine: portal refused a form post - sec-fetch-site=${site ?? "-"} origin=${origin ?? "-"} host=${host ?? "-"} expected=${new URL(settings.baseUrl).origin}\n`,
    );
    return false;
  }

  function insecurePage(): string {
    return messagePage(
      "This page needs HTTPS",
      "A session cookie will not be issued over plain HTTP unless the server is on loopback, because it would travel in the clear. Reach this server over https.",
      false,
    );
  }

  /**
   * A cookie goes out over HTTPS, or over loopback so that this is testable and
   * runnable on a developer machine. Nowhere else.
   */
  function secureEnough(req: IncomingMessage): boolean {
    return isHttps(req) || isLoopback(header(req, "host"));
  }

  async function readForm(
    req: IncomingMessage,
    res: ServerResponse,
  ): Promise<URLSearchParams | null> {
    const type = header(req, "content-type") ?? "";
    if (!type.toLowerCase().startsWith("application/x-www-form-urlencoded")) {
      send(
        res,
        415,
        "text/html; charset=utf-8",
        messagePage("Unsupported form", "This page only accepts ordinary HTML forms."),
        req,
      );
      return null;
    }

    const chunks: Buffer[] = [];
    let size = 0;
    for await (const chunk of req) {
      const buffer = Buffer.from(chunk as Buffer);
      size += buffer.length;
      if (size > MAX_BODY_BYTES) {
        send(
          res,
          413,
          "text/html; charset=utf-8",
          messagePage("That was too large", "A key does not run to kilobytes."),
          req,
        );
        return null;
      }
      chunks.push(buffer);
    }

    return new URLSearchParams(Buffer.concat(chunks).toString("utf8"));
  }

  function flashFor(
    query: URLSearchParams,
    providers: readonly ProviderView[],
  ): { kind: "ok" | "error"; message: string } | null {
    const known = (name: string): string | null => {
      const value = query.get(name);
      return value !== null && providers.some((provider) => provider.id === value)
        ? value
        : null;
    };

    const saved = known("saved");
    if (saved !== null) {
      return {
        kind: "ok",
        message: `The key for ${saved} was saved to Key Vault. It is in use on this replica now, and on every replica within a minute.`,
      };
    }

    const cleared = known("cleared");
    if (cleared !== null) {
      return {
        kind: "ok",
        message: `The stored key for ${cleared} was deleted. It falls back to whatever the environment holds, if anything.`,
      };
    }

    const invalid = known("invalid");
    if (invalid !== null) {
      return {
        kind: "error",
        message: `That did not look like a key for ${invalid}: it must be at least ${MIN_KEY_LENGTH} characters, no longer than ${MAX_KEY_LENGTH}, and contain no spaces.`,
      };
    }

    const failed = known("failed");
    if (failed !== null) {
      return {
        kind: "error",
        message: `The key for ${failed} could not be written. The server's log says why; the value itself was not logged.`,
      };
    }

    return null;
  }

  return {
    handles(path: string): boolean {
      return path === PORTAL_PATH || path.startsWith(`${PORTAL_PATH}/`);
    },

    async handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
      const rawPath = new URL(req.url ?? "/", "http://placeholder").pathname;
      // `/portal/` and `/portal` are the same page to a person typing a URL.
      const path =
        rawPath.length > 1 && rawPath.endsWith("/") ? rawPath.slice(0, -1) : rawPath;
      const method = req.method ?? "GET";

      if (path === PORTAL_STYLE_PATH) {
        if (method !== "GET" && method !== "HEAD")
          return methodNotAllowed(res, "GET", req);
        send(res, 200, "text/css; charset=utf-8", STYLESHEET, req);
        return;
      }

      if (path === PORTAL_PATH) {
        if (method !== "GET" && method !== "HEAD")
          return methodNotAllowed(res, "GET", req);
        return handleIndex(req, res);
      }

      if (path === PORTAL_LOGIN_PATH) {
        if (method !== "GET") return methodNotAllowed(res, "GET", req);
        return handleLogin(req, res);
      }

      if (path === PORTAL_CALLBACK_PATH) {
        if (method !== "GET") return methodNotAllowed(res, "GET", req);
        return handleCallback(req, res);
      }

      if (path === PORTAL_LOGOUT_PATH) {
        if (method !== "POST") return methodNotAllowed(res, "POST", req);
        return handleLogout(req, res);
      }

      if (path.startsWith(PORTAL_KEYS_PREFIX)) {
        if (method !== "POST") return methodNotAllowed(res, "POST", req);
        const id = decodeURIComponent(path.slice(PORTAL_KEYS_PREFIX.length));
        return handleKeyWrite(req, res, id);
      }

      send(
        res,
        404,
        "text/html; charset=utf-8",
        messagePage(
          "No such page",
          "The portal serves the provider console and its login.",
        ),
        req,
      );
    },
  };

  function methodNotAllowed(
    res: ServerResponse,
    allow: string,
    req: IncomingMessage,
  ): void {
    res.setHeader("allow", allow);
    send(
      res,
      405,
      "text/html; charset=utf-8",
      messagePage("Wrong method", `That address answers ${allow}.`),
      req,
    );
  }

  function send(
    res: ServerResponse,
    status: number,
    contentType: string,
    body: string,
    req: IncomingMessage,
  ): void {
    securityHeaders(res, req);
    const payload = Buffer.from(body, "utf8");
    res.writeHead(status, {
      "content-type": contentType,
      "content-length": payload.length,
    });
    res.end(payload);
  }

  function redirect(res: ServerResponse, location: string, req: IncomingMessage): void {
    securityHeaders(res, req);
    // 303 so the browser follows a POST with a GET, which is what makes the
    // save-then-reload cycle safe to refresh.
    res.writeHead(req.method === "POST" ? 303 : 302, { location, "content-length": 0 });
    res.end();
  }

  function securityHeaders(res: ServerResponse, req: IncomingMessage): void {
    res.setHeader("cache-control", "no-store");
    res.setHeader("content-security-policy", CONTENT_SECURITY_POLICY);
    res.setHeader("x-content-type-options", "nosniff");
    res.setHeader("referrer-policy", "no-referrer");
    if (isHttps(req)) {
      res.setHeader("strict-transport-security", "max-age=31536000; includeSubDomains");
    }
  }
}

/** Non-empty, no whitespace, and bounded. Nothing provider-specific: a prefix
 * rule goes stale and refuses a key that would have worked. */
function keyProblem(raw: string): string | null {
  const value = raw.trim();
  if (value.length < MIN_KEY_LENGTH) return "too short";
  if (value.length > MAX_KEY_LENGTH) return "too long";
  if (/\s/.test(value)) return "contains whitespace";
  return null;
}

function isHttps(req: IncomingMessage): boolean {
  const forwarded = header(req, "x-forwarded-proto");
  if (forwarded !== undefined) {
    return forwarded.split(",")[0]?.trim().toLowerCase() === "https";
  }
  return (req.socket as { encrypted?: boolean }).encrypted === true;
}

function isLoopback(host: string | undefined): boolean {
  if (host === undefined) return false;
  const bare = host
    .replace(/:\d+$/, "")
    .replace(/^\[|\]$/g, "")
    .toLowerCase();
  return bare === "localhost" || bare === "::1" || /^127\.\d+\.\d+\.\d+$/.test(bare);
}

function header(req: IncomingMessage, name: string): string | undefined {
  const value = req.headers[name];
  return Array.isArray(value) ? value[0] : value;
}
