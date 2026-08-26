import { describe, expect, it } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { CostLedger } from "../../src/core/budget.js";
import { DEFAULT_CONFIG } from "../../src/core/config-schema.js";
import { loadBundledModelKnowledge } from "../../src/core/knowledge.js";
import { createServer } from "../../src/mcp/server.js";
import { StubProvider } from "../../src/providers/stub.js";

describe("createServer", () => {
  it("lists the tools it was given dependencies for", async () => {
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    const client = new Client({ name: "test", version: "0.0.0" });

    const server = createServer({
      config: DEFAULT_CONFIG,
      knowledge: loadBundledModelKnowledge(),
      ledger: new CostLedger({ budget: DEFAULT_CONFIG.budget }),
      providers: [new StubProvider()],
    });

    await Promise.all([
      server.connect(serverTransport),
      client.connect(clientTransport),
    ]);

    const { tools } = await client.listTools();
    expect(tools.map((tool) => tool.name)).toEqual(["generate_image"]);

    await client.close();
  });
});
