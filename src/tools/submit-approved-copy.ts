import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";

import { OrchestratorAgent } from "../orchestrator.js";
import { allowedActionsForStage } from "./helpers.js";

const schema = z.object({
  run_id: z.string(),
  post_text: z.string().min(1),
  image_prompt: z.string().min(1),
});

export const registerSubmitApprovedCopy = (server: McpServer): void => {
  const orchestrator = new OrchestratorAgent();

  server.tool(
    "submit_approved_copy",
    "Submit the approved LinkedIn post text and image prompt for a run. This locks in the content and transitions the run to image generation.",
    schema.shape,
    async (params) => {
      const input = schema.parse(params);
      const run = await orchestrator.submitApprovedCopy(input.run_id, input.post_text, input.image_prompt);

      return {
        content: [{ type: "text" as const, text: JSON.stringify({
          run_id: run.id,
          stage: run.stage,
          allowed_actions: allowedActionsForStage(run.stage),
          idempotent: false,
          data: {
            message: "Post text and image prompt approved.",
          },
        }) }],
      };
    },
  );
};
