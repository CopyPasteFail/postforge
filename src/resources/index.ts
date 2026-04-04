import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";

import { registerWriterPrompt } from "./writer-prompt.js";
import { registerNewsScoutPrompt } from "./news-scout-prompt.js";
import { registerToolConfig } from "./tool-config.js";
import { registerLatestRun } from "./latest-run.js";

export const registerResources = (server: McpServer): void => {
  registerWriterPrompt(server);
  registerNewsScoutPrompt(server);
  registerToolConfig(server);
  registerLatestRun(server);
};
