import { describe, expect, it } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { CostLedger } from "../../src/core/budget.js";
import { DEFAULT_CONFIG } from "../../src/core/config-schema.js";
import { loadBundledModelKnowledge } from "../../src/core/knowledge.js";
import { createServer } from "../../src/mcp/server.js";
import { StubProvider } from "../../src/providers/stub.js";

async function connectedClient(): Promise<Client> {
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "test", version: "0.0.0" });

  const server = createServer({
    config: DEFAULT_CONFIG,
    knowledge: loadBundledModelKnowledge(),
    ledger: new CostLedger({ budget: DEFAULT_CONFIG.budget }),
    providers: [new StubProvider()],
  });

  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);

  return client;
}

describe("createServer", () => {
  it("lists the tools it was given dependencies for", async () => {
    const client = await connectedClient();

    const { tools } = await client.listTools();
    const names = tools.map((tool) => tool.name);
    expect(names).toContain("generate_image");
    expect(names).toContain("list_capabilities");
    expect(names).toContain("recommend_model");

    await client.close();
  });

  it("declares no JSON Schema dialect on any tool schema", async () => {
    const client = await connectedClient();

    const listing = await client.listTools();
    expect(listing.tools.length).toBeGreaterThan(0);
    expect(JSON.stringify(listing)).not.toContain("json-schema.org");

    for (const tool of listing.tools) {
      expect(tool.inputSchema).not.toHaveProperty("$schema");
      expect(tool.inputSchema.type).toBe("object");
      expect(tool.outputSchema).toBeDefined();
      expect(tool.outputSchema).not.toHaveProperty("$schema");
      expect(tool.outputSchema?.type).toBe("object");
    }

    await client.close();
  });

  it("still returns structuredContent that validates against the output schema", async () => {
    const client = await connectedClient();

    const result = await client.callTool({ name: "list_capabilities", arguments: {} });
    expect(result.isError).not.toBe(true);
    expect(result.structuredContent).toBeTypeOf("object");

    const { tools } = await client.listTools();
    const schema = tools.find(
      (tool) => tool.name === "list_capabilities",
    )?.outputSchema;
    const required = (schema?.required ?? []) as string[];
    expect(required.length).toBeGreaterThan(0);
    for (const key of required) {
      expect(result.structuredContent).toHaveProperty(key);
    }

    await client.close();
  });
});
