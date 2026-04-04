import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";

import { OrchestratorAgent } from "../orchestrator.js";
import { allowedActionsForStage } from "./helpers.js";

const schema = z.object({
  run_id: z.string(),
  candidate_number: z.number().int().min(1),
});

export const registerSelectImageCandidate = (server: McpServer): void => {
  const orchestrator = new OrchestratorAgent();

  server.tool(
    "select_image_candidate",
    "Select an image candidate by its 1-indexed number from the generated candidates list.",
    schema.shape,
    async (params) => {
      const input = schema.parse(params);
      const run = await orchestrator.pickImageByNumber(input.run_id, input.candidate_number);

      return {
        content: [{ type: "text" as const, text: JSON.stringify({
          run_id: run.id,
          stage: run.stage,
          allowed_actions: allowedActionsForStage(run.stage),
          idempotent: false,
          data: {
            selected_image_path: run.selectedImagePath,
            message: `Image candidate ${input.candidate_number} selected.`,
          },
        }) }],
      };
    },
  );
};
