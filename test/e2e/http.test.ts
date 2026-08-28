import { mkdtemp, readdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawn, type ChildProcess } from "node:child_process";
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
});

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
