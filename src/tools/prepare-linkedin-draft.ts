import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";

import { OrchestratorAgent } from "../orchestrator.js";
import { allowedActionsForStage } from "./helpers.js";

const schema = z.object({
  run_id: z.string(),
});

export const registerPrepareLinkedinDraft = (server: McpServer): void => {
  const orchestrator = new OrchestratorAgent();

  server.tool(
    "prepare_linkedin_draft",
    "Open LinkedIn in a persistent Playwright browser, fill the composer with the approved post text, save as draft, and open the selected image folder for manual attachment. Never clicks Post.",
    schema.shape,
    async (params) => {
      const input = schema.parse(params);
      const run = await orchestrator.prepareLinkedIn(input.run_id);

      return {
        content: [{ type: "text" as const, text: JSON.stringify({
          run_id: run.id,
          stage: run.stage,
          allowed_actions: allowedActionsForStage(run.stage),
          idempotent: false,
          data: {
            message: "LinkedIn composer filled and draft saved. Image folder opened. Click Post manually.",
          },
        }) }],
      };
    },
  );
};
