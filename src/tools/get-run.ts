import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";

import { OrchestratorAgent } from "../orchestrator.js";
import { allowedActionsForStage } from "./helpers.js";

const schema = z.object({
  run_id: z.string(),
});

export const registerGetRun = (server: McpServer): void => {
  const orchestrator = new OrchestratorAgent();

  server.tool(
    "get_run",
    "Get the full state of a pipeline run including stage, events, candidates (if at image selection), and allowed next actions.",
    schema.shape,
    async (params) => {
      const input = schema.parse(params);
      const status = await orchestrator.status(input.run_id);

      return {
        content: [{ type: "text" as const, text: JSON.stringify({
          run_id: status.run.id,
          stage: status.run.stage,
          allowed_actions: allowedActionsForStage(status.run.stage),
          idempotent: true,
          data: {
            next_action: status.nextAction,
            run: status.run,
            image_choices: status.imageChoices,
          },
        }) }],
      };
    },
  );
};
