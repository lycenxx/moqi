// An MCP server that answers initialize, then closes its stdin and keeps running: moqi's next writes hit a
// closed pipe (EPIPE), as with a server that exits right after it starts.
import { closeSync, readSync } from "node:fs";

let input = "";
const buffer = Buffer.alloc(65536);
while (!input.includes("\n")) {
  const n = readSync(0, buffer);
  if (n === 0) process.exit(0);
  input += buffer.toString("utf8", 0, n);
}
closeSync(0);
const { id } = JSON.parse(input.split("\n")[0]);
const serverInfo = { name: "deaf", version: "1.0.0" };
process.stdout.write(
  `${JSON.stringify({ jsonrpc: "2.0", id, result: { protocolVersion: "2025-06-18", capabilities: { tools: {} }, serverInfo } })}\n`,
);
setTimeout(() => process.exit(0), 1000);
