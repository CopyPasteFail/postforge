import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";

import { OrchestratorAgent } from "../orchestrator.js";
import { allowedActionsForStage } from "./helpers.js";

const schema = z.object({
  run_id: z.string(),
  tool_id: z.string(),
});

export const registerRetryTool = (server: McpServer): void => {
  const orchestrator = new OrchestratorAgent();

  server.tool(
    "retry_tool",
    "Clear a specific image tool's previous result so it gets retried on the next generate_image_candidates call. Use when the user wants to rerun a specific tool that previously failed or produced a warning.",
    schema.shape,
    async (params) => {
      const input = schema.parse(params);
      try {
        const run = await orchestrator.clearToolAsset(input.run_id, input.tool_id);
        return {
          content: [{ type: "text" as const, text: JSON.stringify({
            run_id: run.id,
            stage: run.stage,
            allowed_actions: allowedActionsForStage(run.stage),
            idempotent: false,
            data: {
              message: `${input.tool_id} cleared. Call generate_image_candidates to retry it.`,
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
