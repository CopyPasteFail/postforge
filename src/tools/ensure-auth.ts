import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";

import { imageToolConfigs, linkedInConfig } from "../config/tools.js";
import { AuthService } from "../playwright/auth.js";

const schema = z.object({
  tool_id: z.enum(["chatgpt", "gemini", "ai-studio", "flow", "grok", "copilot", "linkedin"]),
});

export const registerEnsureAuth = (server: McpServer): void => {
  const auth = new AuthService();

  server.tool(
    "ensure_auth",
    "Ensure authentication for a specific tool. Opens the tool's website in a persistent Playwright browser and waits for the user to log in if needed. Blocks while waiting for login (up to 10 minutes).",
    schema.shape,
    async (params) => {
      const input = schema.parse(params);
      const toolId = input.tool_id;

      const config = toolId === "linkedin"
        ? linkedInConfig
        : imageToolConfigs.find((t) => t.id === toolId);

      if (!config) {
        return {
          content: [{ type: "text" as const, text: JSON.stringify({
            run_id: "n/a",
            stage: "n/a",
            allowed_actions: [],
            idempotent: false,
            data: {
              authenticated: false,
              error: `Unknown tool: ${toolId}`,
            },
          }) }],
        };
      }

      try {
        await auth.ensureAuthenticated(config, true);
        return {
          content: [{ type: "text" as const, text: JSON.stringify({
            run_id: "n/a",
            stage: "n/a",
            allowed_actions: [],
            idempotent: true,
            data: {
              authenticated: true,
              tool_id: toolId,
              tool_name: config.name,
            },
          }) }],
        };
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        return {
          content: [{ type: "text" as const, text: JSON.stringify({
            run_id: "n/a",
            stage: "n/a",
            allowed_actions: ["ensure_auth"],
            idempotent: false,
            data: {
              authenticated: false,
              tool_id: toolId,
              tool_name: config.name,
              login_url: config.url,
              error: message,
            },
          }) }],
        };
      }
    },
  );
};
