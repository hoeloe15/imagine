import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { buildDependencies, createImagineServer } from "./composition.js";
import { createServer } from "./mcp/server.js";
import {
  authSettingsFromEnv,
  createAuthenticator,
  type AuthSettings,
} from "./transport/auth.js";
import {
  httpRequested,
  httpSettingsFromEnv,
  startHttpServer,
  type RunningHttpServer,
} from "./transport/http.js";
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
  const dependencies = await buildDependencies();

  const running = await startHttpServer({
    ...settings,
    ...(auth ? { authenticate: createAuthenticator(auth) } : {}),
    createServer: () => createServer(dependencies),
  });

  process.stderr.write(banner(running, settings.allowedOrigins, auth));

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
    ...(auth === null ? unauthenticatedNotice() : authenticatedNotice(auth)),
    exposure,
    "",
  ].join("\n");
}

function unauthenticatedNotice(): string[] {
  return [
    "  !! THIS ENDPOINT IS UNAUTHENTICATED. Anyone who can reach it can spend",
    "  !! your provider credits and read the images it writes. Set the",
    "  !! IMAGINE_AUTH_* variables to require a Microsoft Entra ID token; until",
    "  !! you do, keep this bound to 127.0.0.1 or put an authenticating proxy",
    "  !! in front of it.",
  ];
}

function authenticatedNotice(auth: AuthSettings): string[] {
  return [
    "  AUTHENTICATED: every POST to /mcp needs a Microsoft Entra ID bearer token.",
    `  tenant:          ${auth.tenantId}`,
    `  issuer:          ${auth.issuer}`,
    `  audience:        ${auth.audiences.join(", ")}`,
    `  required scope:  ${auth.requiredScopes.join(" or ")}`,
    "  /healthz stays open, so probes and load balancers keep working.",
  ];
}
