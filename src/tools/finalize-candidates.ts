import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";

import { OrchestratorAgent } from "../orchestrator.js";
import { allowedActionsForStage } from "./helpers.js";

const schema = z.object({
  run_id: z.string(),
});

export const registerFinalizeCandidates = (server: McpServer): void => {
  const orchestrator = new OrchestratorAgent();

  server.tool(
    "finalize_candidates",
    "SKIP all remaining image tools and go straight to image selection using only the candidates already generated. Use ONLY when the user explicitly says they want to skip or abandon the remaining tools. Do NOT use this to resume or continue generation — call generate_image_candidates to resume from where it left off.",
    schema.shape,
    async (params) => {
      const input = schema.parse(params);
      try {
        const run = await orchestrator.finalizeCandidates(input.run_id);
        const choices = orchestrator.imageChoices(run);
        return {
          content: [{ type: "text" as const, text: JSON.stringify({
            run_id: run.id,
            stage: run.stage,
            allowed_actions: allowedActionsForStage(run.stage),
            idempotent: false,
            data: {
              candidates: choices.map((c) => ({
                number: c.number,
                tool_id: run.imageAssets.find((a) => a.id === c.assetId)?.toolId,
                tool_name: run.imageAssets.find((a) => a.id === c.assetId)?.toolName,
                status: run.imageAssets.find((a) => a.id === c.assetId)?.status,
                file_path: c.filePath,
                variant_id: c.variantId,
                notes: run.imageAssets.find((a) => a.id === c.assetId)?.notes,
              })),
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
