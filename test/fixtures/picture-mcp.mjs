// An MCP server with one read-only tool that returns an image, for moqi's image tests.
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";

const RED =
  "iVBORw0KGgoAAAANSUhEUgAAACAAAAAgCAIAAAD8GO2jAAAAJ0lEQVR42u3NsQkAAAjAsP7/tF7hIASyp6lTCQQCgUAgEAgEgi/BAjLD/C5w/SM9AAAAAElFTkSuQmCC";
const server = new McpServer({ name: "picture", version: "1.0.0" });
server.registerTool(
  "red",
  { description: "Shows a red square", inputSchema: {}, annotations: { readOnlyHint: true } },
  async () => ({ content: [{ type: "image", data: RED, mimeType: "image/png" }] }),
);
await server.connect(new StdioServerTransport());
