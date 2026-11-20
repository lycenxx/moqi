// A small MCP server made with the official SDK, for moqi's MCP client tests.
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";

const server = new McpServer({ name: "echo", version: "1.0.0" });
server.registerTool(
  "echo",
  { description: "Repeats the text", inputSchema: { text: z.string() }, annotations: { readOnlyHint: true } },
  async ({ text }) => ({ content: [{ type: "text", text: `echo: ${text}` }] }),
);
server.registerTool(
  "save note",
  { description: "Saves a note somewhere", inputSchema: { note: z.string() } },
  async ({ note }) => ({ content: [{ type: "text", text: `saved ${note}` }] }),
);
server.registerTool("broken", { description: "Always fails", inputSchema: {} }, async () => ({
  content: [{ type: "text", text: "disk full" }],
  isError: true,
}));
server.registerTool("crash", { description: "Exits", inputSchema: {} }, async () => process.exit(3));
await server.connect(new StdioServerTransport());
