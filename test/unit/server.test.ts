import { describe, expect, it } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { createServer } from "../../src/mcp/server.js";

describe("createServer", () => {
  it("lists no tools yet", async () => {
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    const client = new Client({ name: "test", version: "0.0.0" });

    await Promise.all([
      createServer().connect(serverTransport),
      client.connect(clientTransport),
    ]);

    await expect(client.listTools()).resolves.toEqual({ tools: [] });

    await client.close();
  });
});
