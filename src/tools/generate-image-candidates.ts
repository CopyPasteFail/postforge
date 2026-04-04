import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";

import { OrchestratorAgent } from "../orchestrator.js";
import { allowedActionsForStage } from "./helpers.js";

const schema = z.object({
  run_id: z.string(),
});

export const registerGenerateImageCandidates = (server: McpServer): void => {
  const orchestrator = new OrchestratorAgent();

  server.tool(
    "generate_image_candidates",
    "Run image generation across all enabled AI tools (ChatGPT, Gemini, AI Studio, Flow, Grok, Copilot). This is a long-running operation that opens browsers and generates images sequentially.",
    schema.shape,
    async (params) => {
      const input = schema.parse(params);
      const run = await orchestrator.generateImages(input.run_id);

      const candidates = run.imageAssets.map((asset, index) => ({
        number: index + 1,
        tool_id: asset.toolId,
        tool_name: asset.toolName,
        status: asset.status,
        file_path: asset.files[0],
        variant_id: asset.variants?.[0]?.id,
        notes: asset.notes,
      }));

      const reviewPageNote = run.notes.find((n) => n.includes("review file"));

      return {
        content: [{ type: "text" as const, text: JSON.stringify({
          run_id: run.id,
          stage: run.stage,
          allowed_actions: allowedActionsForStage(run.stage),
          idempotent: false,
          data: {
            candidates: run.stage === "awaiting_image_selection"
              ? orchestrator.imageChoices(run).map((c) => ({
                number: c.number,
                tool_id: run.imageAssets.find((a) => a.id === c.assetId)?.toolId,
                tool_name: run.imageAssets.find((a) => a.id === c.assetId)?.toolName,
                status: run.imageAssets.find((a) => a.id === c.assetId)?.status,
                file_path: c.filePath,
                variant_id: c.variantId,
                notes: run.imageAssets.find((a) => a.id === c.assetId)?.notes,
              }))
              : candidates,
            review_page_path: reviewPageNote,
            auth_required: run.stage === "awaiting_auth" ? {
              tool_id: run.pendingAuth?.toolId,
              tool_name: run.pendingAuth?.toolName,
              url: run.pendingAuth?.url,
            } : undefined,
          },
        }) }],
      };
    },
  );
};
