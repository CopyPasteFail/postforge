import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";

import { OrchestratorAgent } from "../orchestrator.js";
import { allowedActionsForStage } from "./helpers.js";

const schema = z.object({
  run_id: z.string(),
});

export const registerSkipTool = (server: McpServer): void => {
  const orchestrator = new OrchestratorAgent();

  server.tool(
    "skip_tool",
    "Skip the current auth-blocked image tool and resume generation with the remaining tools. Use when the user says they want to skip a tool, move on, or continue without logging in to the current tool.",
    schema.shape,
    async (params) => {
      const input = schema.parse(params);
      try {
        const run = await orchestrator.bypassPendingAuth(input.run_id);
        return {
          content: [{ type: "text" as const, text: JSON.stringify({
            run_id: run.id,
            stage: run.stage,
            allowed_actions: allowedActionsForStage(run.stage),
            idempotent: false,
            data: {
              message: "Tool skipped. Call generate_image_candidates to continue with the remaining tools.",
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
