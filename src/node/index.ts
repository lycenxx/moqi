// Node host: the always-on "home" on a computer.
export { type Config, expandHome, loadConfig, moqiHome, TEMPLATE, writeTemplate } from "./config.js";
export { type Asker, type Console, type ConsoleOptions, confirmQueue, startConsole } from "./console/server.js";
export { acquireLock, fileEventStore } from "./file-store.js";
export { type Home, type HomeOptions, openHome, pluginsFrom } from "./home.js";
export { handleMcp, MCP_VERSIONS, type MoqiLink, serveMcp, TOOLS as MCP_TOOLS } from "./mcp.js";
export { desktopNotifier, type Notifier } from "./notify.js";
