import { describe, expect, it } from "vitest";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const binary = fileURLToPath(new URL("../../dist/index.js", import.meta.url));

describe("the built stdio server", () => {
  it("responds to tools/list with an empty list", async () => {
    const transport = new StdioClientTransport({
      command: process.execPath,
      args: [binary],
    });
    const client = new Client({ name: "test", version: "0.0.0" });

    await client.connect(transport);
    await expect(client.listTools()).resolves.toEqual({ tools: [] });
    await client.close();
  });

  it("exits with code 0 when stdin closes", async () => {
    const child = spawn(process.execPath, [binary], {
      stdio: ["pipe", "pipe", "inherit"],
    });

    child.stdin.end();
    const [code] = await once(child, "exit");

    expect(code).toBe(0);
  });
});
