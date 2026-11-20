// Node host: the always-on "home" on a computer.

export {
  type AgentsPluginOptions,
  agentsPlugin,
  connectAgent,
  disconnectAgent,
  type FoundAgent,
  findAgents,
  type McpCommand,
} from "./agents.js";
export { type Config, expandHome, loadConfig, moqiHome, TEMPLATE, writeTemplate } from "./config.js";
export { A2A_PATH, AGENT_CARD_PATH, agentCard, handleA2A } from "./console/a2a.js";
export { type Asker, type Console, type ConsoleOptions, confirmQueue, startConsole } from "./console/server.js";
export { acquireLock, fileEventStore } from "./file-store.js";
export { defaultAgentsOptions, type Home, type HomeOptions, openHome, pluginsFrom } from "./home.js";
export { handleMcp, MCP_VERSIONS, type MoqiLink, serveMcp, TOOLS as MCP_TOOLS } from "./mcp.js";
export { McpHub, type McpServerConfig, type McpServerStatus, toolName as mcpToolName } from "./mcp-client.js";
export { desktopNotifier, type Notifier } from "./notify.js";
