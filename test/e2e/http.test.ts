import { mkdtemp, readdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawn, type ChildProcess } from "node:child_process";
import { createSign, generateKeyPairSync } from "node:crypto";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { CostLedger } from "../../src/core/budget.js";
import { DEFAULT_CONFIG, type Config } from "../../src/core/config-schema.js";
import { parseModelKnowledge } from "../../src/core/knowledge.js";
import { createServer, type ServerDependencies } from "../../src/mcp/server.js";
import { StubProvider } from "../../src/providers/stub.js";
import { startHttpServer, type RunningHttpServer } from "../../src/transport/http.js";
import {
  allowlistFromEnv,
  authSettingsFromEnv,
  createAuthenticator,
  createAuthoriser,
  type AuthOutcome,
  type AuthSettings,
  type CallerIdentity,
} from "../../src/transport/auth.js";
import type { FetchLike } from "../../src/transport/jwt.js";
import {
  PROTECTED_RESOURCE_PATH,
  protectedResourceFor,
  protectedResourceFromEnv,
} from "../../src/transport/protected-resource.js";

const knowledge = parseModelKnowledge({
  schema_version: 1,
  updated: "2026-08-26",
  disclaimer: "Test fixture.",
  models: [
    {
      id: "stub-image-1",
      display_name: "Stub Image 1",
      family: "stub",
      leaderboard: null,
      strengths: {
        text_in_image: 3,
        photoreal: 3,
        illustration: 4,
        diagram: 4,
        fast_bulk: 5,
      },
      typical_latency_s: 1,
      price: {
        per_image_usd: 0.04,
        per_image_usd_4k: null,
        confidence: "indicative",
        checked: "2026-08-26",
      },
      availability: [{ provider: "stub", model_ref: "stub-image-1" }],
      max_size: "1024x1024",
      notes: "Only exists in tests.",
    },
  ],
});

let directory: string;
let running: RunningHttpServer | undefined;

beforeEach(async () => {
  directory = await mkdtemp(join(tmpdir(), "imagine-http-"));
});

afterEach(async () => {
  await running?.close();
  running = undefined;
});

function dependencies(): ServerDependencies {
  const config: Config = {
    ...structuredClone(DEFAULT_CONFIG),
    output: { ...DEFAULT_CONFIG.output, dir: directory, manifest: null },
    logging: { ...DEFAULT_CONFIG.logging, cost_log: join(directory, "costs.jsonl") },
  };

  return {
    config,
    knowledge,
    ledger: new CostLedger({ budget: config.budget, costLog: config.logging.cost_log }),
    providers: [new StubProvider()],
  };
}

async function serve(
  allowedOrigins: readonly string[] = [],
): Promise<RunningHttpServer> {
  const deps = dependencies();
  running = await startHttpServer({
    host: "127.0.0.1",
    port: 0,
    allowedOrigins,
    createServer: () => createServer(deps),
  });
  return running;
}

async function connect(endpoint: string): Promise<Client> {
  const client = new Client({ name: "test", version: "0.0.0" });
  await client.connect(new StreamableHTTPClientTransport(new URL(endpoint)));
  return client;
}

describe("the streamable HTTP transport", () => {
  it("speaks MCP on /mcp", async () => {
    const server = await serve();
    const client = await connect(server.endpoint);

    const { tools } = await client.listTools();
    await client.close();

    expect(tools.map((tool) => tool.name)).toContain("generate_image");
  });

  it("generates an image over HTTP", async () => {
    const server = await serve();
    const client = await connect(server.endpoint);

    const result = (await client.callTool({
      name: "generate_image",
      arguments: { prompt: "a stub" },
    })) as { isError?: boolean; structuredContent?: Record<string, unknown> };
    await client.close();

    expect(result.isError).toBeFalsy();
    expect(result.structuredContent?.["path"]).toMatch(/\.png$/);
    expect((await readdir(directory)).some((name) => name.endsWith(".png"))).toBe(true);
  });

  it("serves two independent requests, holding no session between them", async () => {
    const server = await serve();
    const first = await connect(server.endpoint);
    const second = await connect(server.endpoint);

    const [a, b] = await Promise.all([first.listTools(), second.listTools()]);
    await Promise.all([first.close(), second.close()]);

    expect(a.tools).toHaveLength(b.tools.length);
  });

  it("refuses a foreign Origin with 403", async () => {
    const server = await serve();

    const response = await fetch(server.endpoint, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        accept: "application/json, text/event-stream",
        origin: "https://evil.example",
      },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list", params: {} }),
    });

    expect(response.status).toBe(403);
    expect(
      ((await response.json()) as { error: { message: string } }).error.message,
    ).toMatch(/IMAGINE_HTTP_ALLOWED_ORIGINS/);
  });

  it("accepts an Origin that was explicitly allowed", async () => {
    const server = await serve(["https://portal.example"]);

    const response = await fetch(server.endpoint, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        accept: "application/json, text/event-stream",
        origin: "https://portal.example",
      },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list", params: {} }),
    });

    expect(response.status).not.toBe(403);
  });

  it("answers a GET on /mcp with 405 and keeps serving", async () => {
    const server = await serve();

    const probe = await fetch(server.endpoint);
    expect(probe.status).toBe(405);
    expect(probe.headers.get("allow")).toBe("POST");

    const client = await connect(server.endpoint);
    await expect(client.listTools()).resolves.toBeDefined();
    await client.close();
  });

  it("answers a plain GET on /healthz with 200", async () => {
    const server = await serve();

    const response = await fetch(server.health);

    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ status: "ok", name: "imagine" });
  });

  it("404s an unknown path", async () => {
    const server = await serve();

    expect((await fetch(`http://127.0.0.1:${server.port}/`)).status).toBe(404);
  });

  it("has no well-known route at all with authentication off", async () => {
    const server = await serve();
    const base = `http://127.0.0.1:${server.port}`;

    expect((await fetch(`${base}${PROTECTED_RESOURCE_PATH}`)).status).toBe(404);
    expect((await fetch(`${base}${PROTECTED_RESOURCE_PATH}/mcp`)).status).toBe(404);
  });
});

describe("the same transport with authentication configured", () => {
  const caller: CallerIdentity = {
    callerId: "tenant:oid",
    subject: "sub",
    objectId: "oid",
    tenantId: "tenant",
    username: "mark@example.com",
    email: "mark@example.com",
    name: "Mark",
    clientId: null,
    scopes: ["access_as_user"],
    roles: [],
    issuer: "https://login.microsoftonline.com/tenant/v2.0",
    audience: "https://imagine.example/mcp",
    expiresAt: 0,
    claims: {},
  };

  const auth: AuthSettings = {
    tenantId: "tenant",
    issuer: "https://login.microsoftonline.com/tenant/v2.0",
    audiences: ["https://imagine.example/mcp"],
    requiredScopes: ["access_as_user"],
    metadataUrls: [
      "https://login.microsoftonline.com/tenant/v2.0/.well-known/openid-configuration",
    ],
  };
  const resource = protectedResourceFor("https://imagine.example/mcp", auth);

  const authenticate = (authorization: string | undefined): Promise<AuthOutcome> => {
    if (authorization === "Bearer good") return Promise.resolve({ ok: true, caller });
    if (authorization === "Bearer readonly") {
      return Promise.resolve({
        ok: false,
        status: 403,
        error: "insufficient_scope",
        message: "The token carries none of the required permissions.",
      });
    }
    return Promise.resolve({
      ok: false,
      status: 401,
      error: authorization === undefined ? null : "invalid_token",
      message: "Authentication required.",
    });
  };

  async function guarded(seen?: (context: { caller: CallerIdentity | null }) => void) {
    const deps = dependencies();
    running = await startHttpServer({
      host: "127.0.0.1",
      port: 0,
      authenticate,
      protectedResource: resource,
      createServer: (context) => {
        seen?.(context);
        return createServer(deps);
      },
    });
    return running;
  }

  function post(endpoint: string, authorization?: string): Promise<Response> {
    return fetch(endpoint, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        accept: "application/json, text/event-stream",
        ...(authorization === undefined ? {} : { authorization }),
      },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list", params: {} }),
    });
  }

  it("refuses a request with no token, and points at the metadata document", async () => {
    const server = await guarded();

    const response = await post(server.endpoint);

    expect(response.status).toBe(401);
    expect(response.headers.get("www-authenticate")).toBe(
      'Bearer resource_metadata="https://imagine.example/.well-known/oauth-protected-resource/mcp", scope="access_as_user"',
    );
    expect(await response.json()).toMatchObject({
      jsonrpc: "2.0",
      error: { code: -32600 },
    });
  });

  it("refuses a bad token with an invalid_token challenge that still points", async () => {
    const server = await guarded();

    const response = await post(server.endpoint, "Bearer stale");

    expect(response.status).toBe(401);
    expect(response.headers.get("www-authenticate")).toMatch(/error="invalid_token"/);
    expect(response.headers.get("www-authenticate")).toMatch(
      /resource_metadata="https:\/\/imagine\.example\/\.well-known\/oauth-protected-resource\/mcp"/,
    );
  });

  it("answers a valid token without the permission with 403 and no pointer", async () => {
    const server = await guarded();

    const response = await post(server.endpoint, "Bearer readonly");

    expect(response.status).toBe(403);
    expect(response.headers.get("www-authenticate")).toMatch(
      /error="insufficient_scope"/,
    );
    expect(response.headers.get("www-authenticate")).not.toMatch(/resource_metadata/);
  });

  it("serves the metadata document, unauthenticated, on both well-known paths", async () => {
    const server = await guarded();
    const base = `http://127.0.0.1:${server.port}`;

    for (const path of [`${PROTECTED_RESOURCE_PATH}/mcp`, PROTECTED_RESOURCE_PATH]) {
      const response = await fetch(`${base}${path}`);

      expect(response.status).toBe(200);
      expect(response.headers.get("content-type")).toMatch(/application\/json/);
      expect(response.headers.get("cache-control")).toBe("no-store");
      expect(await response.json()).toEqual({
        resource: "https://imagine.example/mcp",
        authorization_servers: ["https://login.microsoftonline.com/tenant/v2.0"],
        scopes_supported: ["access_as_user"],
        bearer_methods_supported: ["header"],
        resource_name: "imagine",
      });
    }
  });

  it("publishes a resource that is exactly what the 401 pointed at", async () => {
    const server = await guarded();

    const challenge =
      (await post(server.endpoint)).headers.get("www-authenticate") ?? "";
    const pointer = /resource_metadata="([^"]+)"/.exec(challenge)?.[1] ?? "";

    const document = (await (
      await fetch(`http://127.0.0.1:${server.port}${new URL(pointer).pathname}`)
    ).json()) as { resource: string };

    expect(document.resource).toBe("https://imagine.example/mcp");
  });

  it("answers a POST to the metadata path with 405", async () => {
    const server = await guarded();

    const response = await fetch(
      `http://127.0.0.1:${server.port}${PROTECTED_RESOURCE_PATH}/mcp`,
      { method: "POST" },
    );

    expect(response.status).toBe(405);
    expect(response.headers.get("allow")).toBe("GET, HEAD");
  });

  it("lets a valid token through with the caller attached", async () => {
    const contexts: ({ caller: CallerIdentity | null } | undefined)[] = [];
    const server = await guarded((context) => contexts.push(context));

    const client = new Client({ name: "test", version: "0.0.0" });
    await client.connect(
      new StreamableHTTPClientTransport(new URL(server.endpoint), {
        requestInit: { headers: { authorization: "Bearer good" } },
      }),
    );
    const { tools } = await client.listTools();
    await client.close();

    expect(tools.map((tool) => tool.name)).toContain("generate_image");
    expect(contexts[0]?.caller).toMatchObject({ callerId: "tenant:oid" });
  });

  it("leaves /healthz open", async () => {
    const server = await guarded();

    expect((await fetch(server.health)).status).toBe(200);
  });
});

// The whole point of issue #56: a token from something that is not Entra, with
// no tid and no oid, minted for the MCP URL as its RFC 8707 resource. The
// issuer is faked with generated keys and an injected fetch, so nothing here
// touches the network, but every layer above the socket is the real one.
describe("the same transport in front of a non-Entra OIDC issuer", () => {
  const issuer = "https://imagine-test.authkit.app";
  const jwksUri = `${issuer}/oauth2/jwks`;
  const resourceUrl = "https://imagine.example/mcp";

  const { publicKey, privateKey } = generateKeyPairSync("rsa", {
    modulusLength: 2048,
  });
  const jwk = {
    ...(publicKey.export({ format: "jwk" }) as Record<string, unknown>),
    kid: "authkit-1",
    use: "sig",
    alg: "RS256",
  };

  function token(claims: Record<string, unknown> = {}): string {
    const now = Math.floor(Date.now() / 1000);
    const encode = (value: unknown): string =>
      Buffer.from(JSON.stringify(value)).toString("base64url");
    const signingInput = `${encode({ alg: "RS256", typ: "at+jwt", kid: "authkit-1" })}.${encode(
      {
        iss: issuer,
        aud: resourceUrl,
        sub: "user_01HBEQKA6K4QJAS93VPE39W1JT",
        sid: "session_01HQSXZGF8FHF7A9ZZFCW4387R",
        email: "mark@example.com",
        iat: now - 30,
        exp: now + 3600,
        ...claims,
      },
    )}`;

    const signer = createSign("RSA-SHA256");
    signer.update(signingInput);
    return `${signingInput}.${signer.sign(privateKey.export({ type: "pkcs8", format: "pem" }).toString(), "base64url")}`;
  }

  const issuerFetch: FetchLike = (url) => {
    // Only the RFC 8414 document exists, which is what WorkOS documents.
    if (url === `${issuer}/.well-known/oauth-authorization-server`) {
      return Promise.resolve({
        ok: true,
        status: 200,
        json: () => Promise.resolve({ issuer, jwks_uri: jwksUri }),
      });
    }
    if (url === jwksUri) {
      return Promise.resolve({
        ok: true,
        status: 200,
        json: () => Promise.resolve({ keys: [jwk] }),
      });
    }
    return Promise.resolve({
      ok: false,
      status: 404,
      json: () => Promise.reject(new Error("no such document")),
    });
  };

  const env = {
    IMAGINE_AUTH_ISSUER: issuer,
    IMAGINE_AUTH_AUDIENCE: resourceUrl,
    IMAGINE_MCP_RESOURCE_URI: resourceUrl,
  };

  async function serveBehindIssuer(
    allowedSubjects?: string,
  ): Promise<RunningHttpServer> {
    const settings = authSettingsFromEnv(env);
    if (settings === null) throw new Error("Expected authentication to be configured.");

    const allowlist = allowlistFromEnv(
      allowedSubjects === undefined
        ? env
        : { ...env, IMAGINE_ALLOWED_SUBJECTS: allowedSubjects },
      settings,
    );

    const deps = dependencies();
    running = await startHttpServer({
      host: "127.0.0.1",
      port: 0,
      authenticate: createAuthenticator(settings, { fetch: issuerFetch }),
      ...(allowlist
        ? { authorise: createAuthoriser(allowlist, { log: () => {} }) }
        : {}),
      protectedResource:
        protectedResourceFromEnv(env, settings, { mcpPath: "/mcp" }) ?? undefined,
      createServer: () => createServer(deps),
    });
    return running;
  }

  it("points a client at the issuer, with no scope it cannot satisfy", async () => {
    const server = await serveBehindIssuer();

    const refusal = await fetch(server.endpoint, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "{}",
    });

    expect(refusal.status).toBe(401);
    expect(refusal.headers.get("www-authenticate")).toBe(
      `Bearer resource_metadata="https://imagine.example${PROTECTED_RESOURCE_PATH}/mcp"`,
    );

    const document = await (
      await fetch(`http://127.0.0.1:${server.port}${PROTECTED_RESOURCE_PATH}/mcp`)
    ).json();

    expect(document).toEqual({
      resource: resourceUrl,
      authorization_servers: [issuer],
      bearer_methods_supported: ["header"],
      resource_name: "imagine",
    });
  });

  it("accepts its token and runs a tool with the caller attached", async () => {
    const server = await serveBehindIssuer();

    const client = new Client({ name: "test", version: "0.0.0" });
    await client.connect(
      new StreamableHTTPClientTransport(new URL(server.endpoint), {
        requestInit: { headers: { authorization: `Bearer ${token()}` } },
      }),
    );
    const { tools } = await client.listTools();
    await client.close();

    expect(tools.map((tool) => tool.name)).toContain("generate_image");
  });

  it("lets an allowlisted subject run a tool, exactly as before", async () => {
    const server = await serveBehindIssuer("user_01HBEQKA6K4QJAS93VPE39W1JT");

    const client = new Client({ name: "test", version: "0.0.0" });
    await client.connect(
      new StreamableHTTPClientTransport(new URL(server.endpoint), {
        requestInit: { headers: { authorization: `Bearer ${token()}` } },
      }),
    );
    const { tools } = await client.listTools();
    await client.close();

    expect(tools.map((tool) => tool.name)).toContain("generate_image");
  });

  it("refuses a valid token from another account with 403 and no pointer", async () => {
    const server = await serveBehindIssuer("user_SOMEONE_ELSE");

    const response = await fetch(server.endpoint, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        accept: "application/json, text/event-stream",
        authorization: `Bearer ${token()}`,
      },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list", params: {} }),
    });

    expect(response.status).toBe(403);
    expect(response.headers.get("www-authenticate")).toBeNull();
    const body = (await response.json()) as { error: { message: string } };
    expect(body.error.message).toMatch(/IMAGINE_ALLOWED_SUBJECTS/);
    expect(body.error.message).toContain("user_01HBEQKA6K4QJAS93VPE39W1JT");
  });

  it("accepts the same caller by verified email instead of subject", async () => {
    const server = await serveBehindIssuer("email:MARK@Example.com");

    const response = await fetch(server.endpoint, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        accept: "application/json, text/event-stream",
        authorization: `Bearer ${token()}`,
      },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list", params: {} }),
    });

    expect(response.status).toBe(200);
  });

  it("still refuses a token minted for another resource", async () => {
    const server = await serveBehindIssuer();

    const response = await fetch(server.endpoint, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        accept: "application/json, text/event-stream",
        authorization: `Bearer ${token({ aud: "https://someone-else.example/mcp" })}`,
      },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list", params: {} }),
    });

    expect(response.status).toBe(401);
    expect(response.headers.get("www-authenticate")).toMatch(/error="invalid_token"/);
  });
});

describe("the built binary with --http", () => {
  const binary = fileURLToPath(new URL("../../dist/index.js", import.meta.url));
  let child: ChildProcess | undefined;

  afterEach(() => {
    child?.kill();
    child = undefined;
  });

  it("serves an unauthenticated endpoint and says so", async () => {
    const spawned = spawn(process.execPath, [binary, "--http"], {
      cwd: directory,
      env: {
        ...process.env,
        HOME: directory,
        USERPROFILE: directory,
        IMAGINE_HTTP_PORT: "0",
        IMAGINE_HTTP_HOST: "127.0.0.1",
      },
      stdio: ["ignore", "ignore", "pipe"],
    });
    child = spawned;

    const banner = await readUntil(spawned, /endpoint:\s+(\S+)/);
    expect(banner).toMatch(/UNAUTHENTICATED/);

    const endpoint = /endpoint:\s+(\S+)/.exec(banner)?.[1] ?? "";
    const health = endpoint.replace(/\/mcp$/, "/healthz");

    expect((await fetch(health)).status).toBe(200);

    const client = await connect(endpoint);
    const { tools } = await client.listTools();
    await client.close();

    expect(tools.map((tool) => tool.name)).toContain("generate_image");
  });

  it("guards the endpoint and says so when IMAGINE_AUTH_* is set", async () => {
    const spawned = spawn(process.execPath, [binary, "--http"], {
      cwd: directory,
      env: {
        ...process.env,
        HOME: directory,
        USERPROFILE: directory,
        IMAGINE_HTTP_PORT: "0",
        IMAGINE_HTTP_HOST: "127.0.0.1",
        IMAGINE_AUTH_TENANT_ID: "11111111-2222-3333-4444-555555555555",
        IMAGINE_AUTH_AUDIENCE: "https://imagine.example/mcp",
        IMAGINE_PUBLIC_URL: "https://imagine.example",
      },
      stdio: ["ignore", "ignore", "pipe"],
    });
    child = spawned;

    const banner = await readUntil(spawned, /endpoint:\s+(\S+)/);
    expect(banner).toMatch(/AUTHENTICATED: every POST/);
    expect(banner).not.toMatch(/THIS ENDPOINT IS UNAUTHENTICATED/);
    expect(banner).toMatch(
      /metadata:\s+https:\/\/imagine\.example\/\.well-known\/oauth-protected-resource\/mcp/,
    );

    const endpoint = /endpoint:\s+(\S+)/.exec(banner)?.[1] ?? "";
    expect((await fetch(endpoint.replace(/\/mcp$/, "/healthz"))).status).toBe(200);

    const metadata = await fetch(
      endpoint.replace(/\/mcp$/, `${PROTECTED_RESOURCE_PATH}/mcp`),
    );
    expect(metadata.status).toBe(200);
    expect(await metadata.json()).toMatchObject({
      resource: "https://imagine.example/mcp",
    });

    const response = await fetch(endpoint, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        accept: "application/json, text/event-stream",
      },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list", params: {} }),
    });

    expect(response.status).toBe(401);
    expect(response.headers.get("www-authenticate")).toBe(
      'Bearer resource_metadata="https://imagine.example/.well-known/oauth-protected-resource/mcp", scope="access_as_user"',
    );
  });

  it("reports the allowlist in the banner without naming anyone", async () => {
    const spawned = spawn(process.execPath, [binary, "--http"], {
      cwd: directory,
      env: {
        ...process.env,
        HOME: directory,
        USERPROFILE: directory,
        IMAGINE_HTTP_PORT: "0",
        IMAGINE_HTTP_HOST: "127.0.0.1",
        IMAGINE_AUTH_ISSUER: "https://imagine-test.authkit.app",
        IMAGINE_AUTH_AUDIENCE: "https://imagine.example/mcp",
        IMAGINE_ALLOWED_SUBJECTS: "user_01HBEQ, email:mark@example.com",
      },
      stdio: ["ignore", "ignore", "pipe"],
    });
    child = spawned;

    const banner = await readUntil(spawned, /endpoint:\s+(\S+)/);

    expect(banner).toMatch(/allowlist:\s+on, 2 entries/);
    expect(banner).not.toContain("user_01HBEQ");
    expect(banner).not.toContain("mark@example.com");
  });

  it("refuses to start with an allowlist and no authentication", async () => {
    const spawned = spawn(process.execPath, [binary, "--http"], {
      cwd: directory,
      env: {
        ...process.env,
        HOME: directory,
        USERPROFILE: directory,
        IMAGINE_HTTP_PORT: "0",
        IMAGINE_HTTP_HOST: "127.0.0.1",
        IMAGINE_ALLOWED_SUBJECTS: "user_01HBEQ",
      },
      stdio: ["ignore", "ignore", "pipe"],
    });
    child = spawned;

    const { code, stderr } = await exited(spawned);

    expect(code).not.toBe(0);
    expect(stderr).toMatch(/IMAGINE_ALLOWED_SUBJECTS/);
    expect(stderr).toMatch(/authentication is off/);
  });
});

function exited(child: ChildProcess): Promise<{ code: number | null; stderr: string }> {
  return new Promise((resolve, reject) => {
    let stderr = "";
    const timer = setTimeout(
      () => reject(new Error(`Never exited. Saw: ${stderr}`)),
      15_000,
    );

    child.stderr?.on("data", (chunk: Buffer) => (stderr += chunk.toString()));
    child.once("exit", (code) => {
      clearTimeout(timer);
      resolve({ code, stderr });
    });
  });
}

function readUntil(child: ChildProcess, pattern: RegExp): Promise<string> {
  return new Promise((resolve, reject) => {
    let buffered = "";
    const timer = setTimeout(
      () => reject(new Error(`Never matched. Saw: ${buffered}`)),
      15_000,
    );

    child.stderr?.on("data", (chunk: Buffer) => {
      buffered += chunk.toString();
      if (pattern.test(buffered)) {
        clearTimeout(timer);
        resolve(buffered);
      }
    });
    child.once("exit", (code) => {
      clearTimeout(timer);
      reject(new Error(`Exited with ${code} before matching. Saw: ${buffered}`));
    });
  });
}
