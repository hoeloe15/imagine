/**
 * What the portal needs to exist, read from the environment.
 *
 * The portal is off unless it is switched on *and* the MCP endpoint is
 * authenticated. A page that writes provider keys behind no login is not a
 * convenience mode, it is the failure ADR 0021 refused to leave available, so
 * "enabled but no IMAGINE_AUTH_*" is a warning and a 404 rather than an open
 * page. Missing configuration that the operator *did* ask for — a client id, a
 * public URL — throws at startup instead, the way half-configured
 * authentication always has.
 *
 * The three URLs default to WorkOS AuthKit's and are overridable, because
 * nothing else in `src/` names a vendor (ADR 0023) and an operator on another
 * authorization server should not have to fork the file.
 */

import type { Env } from "../core/config.js";
import type { AuthSettings } from "../transport/auth.js";

export const PORTAL_PATH = "/portal";
export const PORTAL_LOGIN_PATH = `${PORTAL_PATH}/auth/login`;
export const PORTAL_CALLBACK_PATH = `${PORTAL_PATH}/auth/callback`;
export const PORTAL_LOGOUT_PATH = `${PORTAL_PATH}/auth/logout`;
export const PORTAL_STYLE_PATH = `${PORTAL_PATH}/style.css`;
export const PORTAL_KEYS_PREFIX = `${PORTAL_PATH}/keys/`;

export const PORTAL_ENABLED_ENV = "IMAGINE_PORTAL_ENABLED";
export const PORTAL_CLIENT_ID_ENV = "IMAGINE_PORTAL_WORKOS_CLIENT_ID";
export const PORTAL_SESSION_SECRET_ENV = "IMAGINE_PORTAL_SESSION_SECRET";
export const PORTAL_CLIENT_SECRET_NAME_ENV = "IMAGINE_PORTAL_CLIENT_SECRET_NAME";
export const PORTAL_AUTHORIZE_URL_ENV = "IMAGINE_PORTAL_AUTHORIZE_URL";
export const PORTAL_TOKEN_URL_ENV = "IMAGINE_PORTAL_TOKEN_URL";
export const PORTAL_LOGOUT_URL_ENV = "IMAGINE_PORTAL_LOGOUT_URL";
export const PORTAL_BASE_URL_ENV = "IMAGINE_PORTAL_PUBLIC_URL";

export const DEFAULT_AUTHORIZE_URL = "https://api.workos.com/user_management/authorize";
export const DEFAULT_TOKEN_URL = "https://api.workos.com/user_management/authenticate";
export const DEFAULT_LOGOUT_URL =
  "https://api.workos.com/user_management/sessions/logout";

/** The vault secret the client secret lives in, if one turns out to be needed. */
export const DEFAULT_CLIENT_SECRET_NAME = "workos-client-secret";

/** How long a login may sit half-finished before its state cookie is stale. */
export const LOGIN_WINDOW_SECONDS = 10 * 60;

/** How long a session lasts. There is no refresh in slice 1; it expires. */
export const SESSION_SECONDS = 8 * 60 * 60;

export interface PortalSettings {
  /** Public origin of this server, without a trailing slash. */
  baseUrl: string;
  /** `<baseUrl>/portal`, which is also the portal's own resource indicator. */
  resource: string;
  redirectUri: string;
  clientId: string;
  authorizeUrl: string;
  tokenUrl: string;
  /** `null` when the operator cleared it: logout then just drops the cookie. */
  logoutUrl: string | null;
  /** Vault secret holding the token-endpoint client secret, if one is needed. */
  clientSecretName: string;
  /** Explicit when {@link PORTAL_SESSION_SECRET_ENV} is set. */
  sessionSecret: string | null;
  sessionSeconds: number;
  loginWindowSeconds: number;
}

export type PortalConfiguration =
  | { enabled: true; settings: PortalSettings }
  | { enabled: false; warning: string | null };

function trimmed(value: string | undefined): string {
  return value?.trim() ?? "";
}

function flag(value: string | undefined): boolean {
  return ["1", "true", "yes", "on"].includes(trimmed(value).toLowerCase());
}

function stripTrailingSlash(value: string): string {
  return value.replace(/\/+$/, "");
}

function absoluteUrl(raw: string, variable: string): string {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new Error(`${variable} must be an absolute URL, not ${JSON.stringify(raw)}.`);
  }
  if (url.protocol !== "https:" && url.protocol !== "http:") {
    throw new Error(
      `${variable} must be an http or https URL, not ${JSON.stringify(raw)}.`,
    );
  }
  return stripTrailingSlash(url.toString());
}

/**
 * The public origin, from the same places the protected-resource document
 * already looks (ADR 0021): an explicit portal URL, then IMAGINE_PUBLIC_URL,
 * then the origin of the MCP resource URI, then the origin of the first
 * http(s) audience. Nothing reads the `Host` header — behind Container Apps
 * ingress that is the platform's host, and a redirect URI has to match the
 * string registered with the authorization server exactly.
 */
function baseUrlFrom(env: Env, auth: AuthSettings): string | null {
  const candidates = [
    trimmed(env[PORTAL_BASE_URL_ENV]),
    trimmed(env.IMAGINE_PUBLIC_URL),
    trimmed(env.IMAGINE_MCP_RESOURCE_URI),
    auth.audiences.find((value) => /^https?:\/\//i.test(value)) ?? "",
  ];

  for (const candidate of candidates) {
    if (candidate === "") continue;
    try {
      const url = new URL(candidate);
      if (url.protocol !== "https:" && url.protocol !== "http:") continue;
      return `${url.protocol}//${url.host}`;
    } catch {
      continue;
    }
  }
  return null;
}

export function portalSettingsFromEnv(
  env: Env,
  auth: AuthSettings | null,
): PortalConfiguration {
  if (!flag(env[PORTAL_ENABLED_ENV])) return { enabled: false, warning: null };

  if (auth === null) {
    return {
      enabled: false,
      warning: `${PORTAL_ENABLED_ENV} is on, but no IMAGINE_AUTH_* variable is set, so there is no login to put in front of a page that writes provider keys. The portal routes do not exist and answer 404. Configure authentication, or unset ${PORTAL_ENABLED_ENV}.`,
    };
  }

  const clientId = trimmed(env[PORTAL_CLIENT_ID_ENV]);
  if (clientId === "") {
    throw new Error(
      `${PORTAL_CLIENT_ID_ENV} is required when ${PORTAL_ENABLED_ENV} is on. It is the public client id of the portal's own application at ${auth.issuer} — in the WorkOS dashboard, Developer → API Keys.`,
    );
  }

  const baseUrl = baseUrlFrom(env, auth);
  if (baseUrl === null) {
    throw new Error(
      `The portal is on but this server does not know its own public URL, so it cannot build the redirect URI the authorization server has to match exactly. Set ${PORTAL_BASE_URL_ENV} or IMAGINE_PUBLIC_URL to the public origin, for example https://example.azurecontainerapps.io.`,
    );
  }

  const logoutRaw = env[PORTAL_LOGOUT_URL_ENV];
  const logoutConfigured =
    logoutRaw === undefined ? DEFAULT_LOGOUT_URL : trimmed(logoutRaw);

  return {
    enabled: true,
    settings: Object.freeze({
      baseUrl,
      resource: `${baseUrl}${PORTAL_PATH}`,
      redirectUri: `${baseUrl}${PORTAL_CALLBACK_PATH}`,
      clientId,
      authorizeUrl: absoluteUrl(
        trimmed(env[PORTAL_AUTHORIZE_URL_ENV]) || DEFAULT_AUTHORIZE_URL,
        PORTAL_AUTHORIZE_URL_ENV,
      ),
      tokenUrl: absoluteUrl(
        trimmed(env[PORTAL_TOKEN_URL_ENV]) || DEFAULT_TOKEN_URL,
        PORTAL_TOKEN_URL_ENV,
      ),
      logoutUrl:
        logoutConfigured === ""
          ? null
          : absoluteUrl(logoutConfigured, PORTAL_LOGOUT_URL_ENV),
      clientSecretName:
        trimmed(env[PORTAL_CLIENT_SECRET_NAME_ENV]) || DEFAULT_CLIENT_SECRET_NAME,
      sessionSecret: trimmed(env[PORTAL_SESSION_SECRET_ENV]) || null,
      sessionSeconds: SESSION_SECONDS,
      loginWindowSeconds: LOGIN_WINDOW_SECONDS,
    }),
  };
}
