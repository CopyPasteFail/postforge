import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";

import { imageToolConfigs, linkedInConfig } from "../config/tools.js";

export const registerToolConfig = (server: McpServer): void => {
  server.resource(
    "tool-config",
    "linkedin://config/tools",
    { description: "Current image tool configuration: which tools are enabled, their names, URLs, and settings" },
    async () => {
      const enabledTools = imageToolConfigs.map((tool) => {
        const envKey = `IMAGE_TOOL_${tool.id.replace(/-/g, "_").toUpperCase()}_ENABLED`;
        const configured = process.env[envKey];
        const enabled = configured != null
          ? /^true$/i.test(configured)
          : tool.id !== "grok";

        return {
          id: tool.id,
          name: tool.name,
          url: tool.url,
          setting: tool.setting,
          enabled,
        };
      });

      const config = {
        image_tools: enabledTools,
        linkedin: {
          id: linkedInConfig.id,
          name: linkedInConfig.name,
          url: linkedInConfig.url,
          compose_url: linkedInConfig.composeUrl,
        },
      };

      return {
        contents: [{
          uri: "linkedin://config/tools",
          mimeType: "application/json",
          text: JSON.stringify(config, null, 2),
        }],
      };
    },
  );
};
