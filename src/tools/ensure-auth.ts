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
    [
      "Check and open authentication for a specific tool.",
      "Opens the tool's website in a persistent Playwright browser and checks immediately.",
      "If already logged in, returns authenticated:true right away.",
      "If not logged in, opens the browser window for the user to log in and returns awaiting_login — call ensure_auth again once the user confirms they have logged in.",
      "Never blocks waiting for login.",
    ].join(" "),
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
        const result = await auth.openAndCheckAuth(config);

        if (result.status === "authenticated") {
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
        }

        // Browser is open, waiting for user to log in and call again.
        return {
          content: [{ type: "text" as const, text: JSON.stringify({
            run_id: "n/a",
            stage: "n/a",
            allowed_actions: ["ensure_auth"],
            idempotent: false,
            data: {
              authenticated: false,
              awaiting_login: true,
              tool_id: toolId,
              tool_name: config.name,
              login_url: result.loginUrl,
              next_step: result.message,
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
