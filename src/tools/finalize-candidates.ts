import { pathToFileURL } from "node:url";

import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";

import { OrchestratorAgent } from "../orchestrator.js";
import { allowedActionsForStage } from "./helpers.js";

const toFileUrl = (p: string | undefined): string | undefined => {
  if (!p) return undefined;
  try {
    return pathToFileURL(p).toString();
  } catch {
    return undefined;
  }
};

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
              candidates: choices.map((c) => {
                const asset = run.imageAssets.find((a) => a.id === c.assetId);
                const variantLabel = c.variantId
                  ? asset?.variants?.find((v) => v.id === c.variantId)?.label
                  : undefined;
                return {
                  number: c.number,
                  tool_id: asset?.toolId,
                  tool_name: asset?.toolName,
                  status: asset?.status,
                  file_path: c.filePath,
                  file_url: toFileUrl(c.filePath),
                  display_name: c.displayName,
                  variant_id: c.variantId,
                  variant_label: variantLabel,
                  notes: asset?.notes,
                };
              }),
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
