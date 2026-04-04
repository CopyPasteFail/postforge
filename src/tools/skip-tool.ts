import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";

import { OrchestratorAgent } from "../orchestrator.js";
import { allowedActionsForStage } from "./helpers.js";

const schema = z.object({
  run_id: z.string(),
  tool_id: z.string().optional(),
});

export const registerSkipTool = (server: McpServer): void => {
  const orchestrator = new OrchestratorAgent();

  server.tool(
    "skip_tool",
    "Skip a specific image tool and mark it as skipped. Works in two modes: (1) if tool_id is provided, skips that specific tool regardless of auth state; (2) if tool_id is omitted, skips the currently auth-blocked tool. Use when the user says to skip a tool, move on, or continue without a specific tool.",
    schema.shape,
    async (params) => {
      const input = schema.parse(params);
      try {
        const run = input.tool_id
          ? await orchestrator.skipTool(input.run_id, input.tool_id)
          : await orchestrator.bypassPendingAuth(input.run_id);
        return {
          content: [{ type: "text" as const, text: JSON.stringify({
            run_id: run.id,
            stage: run.stage,
            allowed_actions: allowedActionsForStage(run.stage),
            idempotent: false,
            data: {
              message: `${input.tool_id ?? "Tool"} skipped. Call generate_image_candidates to continue with the remaining tools.`,
            },
          }) }],
        };
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        return { content: [{ type: "text" as const, text: JSON.stringify({ error: message }) }], isError: true };
      }
    },
  );
};
