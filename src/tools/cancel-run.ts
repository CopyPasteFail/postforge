import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";

import { OrchestratorAgent } from "../orchestrator.js";

const schema = z.object({
  run_id: z.string(),
});

export const registerCancelRun = (server: McpServer): void => {
  const orchestrator = new OrchestratorAgent();

  server.tool(
    "cancel_run",
    "Cancel an active pipeline run. Sets the stage to archived.",
    schema.shape,
    async (params) => {
      const input = schema.parse(params);
      const run = await orchestrator.cancelRun(input.run_id);

      return {
        content: [{ type: "text" as const, text: JSON.stringify({
          run_id: run.id,
          stage: run.stage,
          allowed_actions: [],
          idempotent: false,
          data: {
            message: "Run cancelled.",
          },
        }) }],
      };
    },
  );
};
