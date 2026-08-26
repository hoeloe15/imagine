import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { createImagineServer } from "./composition.js";

const server = await createImagineServer();
await server.connect(new StdioServerTransport());
