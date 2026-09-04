import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { buildDependencies, createImagineServer } from "./composition.js";
import { createServer } from "./mcp/server.js";
import {
  allowlistFromEnv,
  authSettingsFromEnv,
  createAuthenticator,
  createAuthoriser,
  type Allowlist,
  type AuthSettings,
} from "./transport/auth.js";
import {
  httpRequested,
  httpSettingsFromEnv,
  MCP_PATH,
  startHttpServer,
  type RunningHttpServer,
} from "./transport/http.js";
import {
  protectedResourceFromEnv,
  type ProtectedResource,
} from "./transport/protected-resource.js";
import { createPortal } from "./portal/portal.js";
import {
  portalSettingsFromEnv,
  PORTAL_PATH,
  type PortalSettings,
} from "./portal/settings.js";
import { version } from "./version.js";

if (httpRequested(process.argv.slice(2), process.env)) {
  await serveHttp();
} else {
  const server = await createImagineServer();
  await server.connect(new StdioServerTransport());
}

async function serveHttp(): Promise<void> {
  const settings = httpSettingsFromEnv(process.env);
  const auth = authSettingsFromEnv(process.env);
  const allowlist = allowlistFromEnv(process.env, auth);
  const resource = protectedResourceFromEnv(process.env, auth, { mcpPath: MCP_PATH });
  const dependencies = await buildDependencies();

  const authenticate = auth ? createAuthenticator(auth) : undefined;
  const authorise = allowlist ? createAuthoriser(allowlist) : undefined;

  const portalConfiguration = portalSettingsFromEnv(process.env, auth);
  const portal =
    portalConfiguration.enabled && auth
      ? createPortal({
          settings: portalConfiguration.settings,
          config: dependencies.config,
          secrets: dependencies.secrets,
          knowledge: dependencies.knowledge,
          providers: dependencies.providers,
          verifications: dependencies.verifications,
          auth,
          ...(dependencies.vault ? { vault: dependencies.vault } : {}),
          ...(authenticate ? { authenticate } : {}),
          ...(authorise ? { authorise } : {}),
        })
      : undefined;

  const running = await startHttpServer({
    ...settings,
    ...(authenticate ? { authenticate } : {}),
    ...(authorise ? { authorise } : {}),
    ...(resource ? { protectedResource: resource } : {}),
    ...(portal ? { portal } : {}),
    createServer: () => createServer(dependencies),
  });

  process.stderr.write(
    banner(
      running,
      settings.allowedOrigins,
      auth,
      allowlist,
      resource,
      portalConfiguration.enabled ? portalConfiguration.settings : null,
      portalConfiguration.enabled ? null : portalConfiguration.warning,
    ),
  );

  for (const signal of ["SIGINT", "SIGTERM"] as const) {
    process.once(signal, () => {
      void running.close().then(() => process.exit(0));
    });
  }
}

function banner(
  running: RunningHttpServer,
  allowedOrigins: readonly string[],
  auth: AuthSettings | null,
  allowlist: Allowlist | null,
  resource: ProtectedResource | null,
  portal: PortalSettings | null,
  portalWarning: string | null,
): string {
  const origins =
    allowedOrigins.length === 0
      ? "same-origin and loopback only (IMAGINE_HTTP_ALLOWED_ORIGINS is unset)"
      : allowedOrigins.join(", ");

  const exposure =
    running.host === "127.0.0.1" ||
    running.host === "localhost" ||
    running.host === "::1"
      ? ""
      : `\n  It is bound to ${running.host}, so it is reachable from the network.\n`;

  return [
    `imagine ${version} — MCP over Streamable HTTP`,
    `  endpoint:        ${running.endpoint}  (POST)`,
    `  health:          ${running.health}`,
    `  allowed origins: ${origins}`,
    "",
    ...(auth === null
      ? unauthenticatedNotice()
      : [...authenticatedNotice(auth, allowlist), ...discoveryNotice(resource)]),
    ...portalNotice(portal, portalWarning),
    exposure,
    "",
  ].join("\n");
}

function portalNotice(portal: PortalSettings | null, warning: string | null): string[] {
  if (warning !== null) {
    return ["", `  !! ${warning}`];
  }
  if (portal === null) return [];

  return [
    "",
    `  PORTAL: ${portal.resource}  (browser login, session cookie only)`,
    `  redirect URI:    ${portal.redirectUri}  — register this exactly`,
    `  client id:       ${portal.clientId}`,
    portal.sessionSecret === null
      ? "  session key:     random for this process, so a new revision or replica means a new login"
      : "  session key:     from IMAGINE_PORTAL_SESSION_SECRET, so sessions survive a revision",
    `  ${PORTAL_PATH} ignores Authorization headers, and ${MCP_PATH} ignores cookies.`,
  ];
}

function unauthenticatedNotice(): string[] {
  return [
    "  !! THIS ENDPOINT IS UNAUTHENTICATED. Anyone who can reach it can spend",
    "  !! your provider credits and read the images it writes. Set the",
    "  !! IMAGINE_AUTH_* variables to require a verified bearer token; until",
    "  !! you do, keep this bound to 127.0.0.1 or put an authenticating proxy",
    "  !! in front of it.",
  ];
}

function authenticatedNotice(
  auth: AuthSettings,
  allowlist: Allowlist | null,
): string[] {
  return [
    auth.tenantId === null
      ? "  AUTHENTICATED: every POST to /mcp needs a bearer token from the issuer below."
      : "  AUTHENTICATED: every POST to /mcp needs a Microsoft Entra ID bearer token.",
    auth.tenantId === null
      ? "  tenant:          none configured, so the tid claim is not checked"
      : `  tenant:          ${auth.tenantId}`,
    `  issuer:          ${auth.issuer}`,
    `  discovery:       ${auth.metadataUrls.join(", ")}`,
    `  audience:        ${auth.audiences.join(", ")}`,
    auth.requiredScopes.length === 0
      ? "  required scope:  none — any token this issuer minted for this resource is accepted"
      : `  required scope:  ${auth.requiredScopes.join(" or ")}`,
    allowlist === null
      ? "  allowlist:       none — every account this issuer signs in may call /mcp"
      : `  allowlist:       on, ${allowlist.size} ${allowlist.size === 1 ? "entry" : "entries"} — anyone else is refused with 403`,
    "  /healthz stays open, so probes and load balancers keep working.",
  ];
}

function discoveryNotice(resource: ProtectedResource | null): string[] {
  if (resource === null) {
    return [
      "",
      "  !! No protected-resource metadata is being served, because this server",
      "  !! does not know its own public URL. Claude cannot start OAuth without",
      "  !! it. Set IMAGINE_PUBLIC_URL to the public origin, or",
      "  !! IMAGINE_MCP_RESOURCE_URI to the endpoint URL itself.",
    ];
  }

  return [
    `  resource:        ${resource.resource}`,
    `  metadata:        ${resource.metadataUrl}  (open, GET)`,
  ];
}
