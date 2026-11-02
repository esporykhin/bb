import { McpServer } from "@modelcontextprotocol/server";
import { StdioServerTransport } from "@modelcontextprotocol/server/stdio";
import { z } from "zod";
const server = new McpServer({ name: "hub-stdio-fixture", version: "1.0.0" });
let count = 0;
server.registerTool(
  "stdio_echo",
  {
    description: "Echo via real stdio",
    inputSchema: z.object({ value: z.string() }),
  },
  async ({ value }) => ({
    content: [
      {
        type: "text",
        text: JSON.stringify({
          value,
          count: ++count,
          configured: process.env.HUB_TEST_KEY === "stdio-private-value",
          pid: process.pid,
        }),
      },
    ],
  }),
);
await server.connect(new StdioServerTransport());
