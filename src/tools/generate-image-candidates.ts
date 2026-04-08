import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";

import { OrchestratorAgent } from "../orchestrator.js";
import { runPaths } from "../config/paths.js";
import { imageToolConfigs, linkedInConfig } from "../config/tools.js";
import { AuthService } from "../playwright/auth.js";
import { allowedActionsForStage, extractReviewPagePath } from "./helpers.js";

const schema = z.object({
  run_id: z.string(),
});

export const registerGenerateImageCandidates = (server: McpServer): void => {
  const orchestrator = new OrchestratorAgent();
  const auth = new AuthService();

  server.tool(
    "generate_image_candidates",
    "Run image generation across all enabled AI tools (ChatGPT, Gemini, AI Studio, Flow, Grok, Copilot). This is a long-running operation that opens browsers and generates images sequentially.",
    schema.shape,
    async (params) => {
      const input = schema.parse(params);
      let run: Awaited<ReturnType<typeof orchestrator.generateImages>>;
      try {
        run = await orchestrator.generateImages(input.run_id);
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        return { content: [{ type: "text" as const, text: JSON.stringify({ error: message }) }], isError: true };
      }

      const candidates = run.imageAssets.map((asset, index) => ({
        number: index + 1,
        tool_id: asset.toolId,
        tool_name: asset.toolName,
        status: asset.status,
        file_path: asset.files[0],
        variant_id: asset.variants?.[0]?.id,
        notes: asset.notes,
      }));

      const reviewPagePath = extractReviewPagePath(run);
      const paths = runPaths(run.id);

      // When auth/CAPTCHA is required, open the browser so the user can act.
      let authNextStep: string | undefined;
      if (run.stage === "awaiting_auth" && run.pendingAuth) {
        const isCaptcha = run.pendingAuth.reason?.toLowerCase().includes("captcha")
          || run.pendingAuth.reason?.toLowerCase().includes("human verification");

        if (isCaptcha) {
          // CAPTCHA: the browser window is already open (kept alive by CaptchaRequiredError).
          // Don't open a new window — just tell the user to complete it.
          authNextStep = `${run.pendingAuth.toolName} is showing a human verification challenge (CAPTCHA). The browser window may still be open — please complete the challenge there, then call generate_image_candidates again to resume.`;
        } else {
          // Auth: open the browser so the user can log in.
          const pendingConfig = run.pendingAuth.toolId === "linkedin"
            ? linkedInConfig
            : imageToolConfigs.find((t) => t.id === run.pendingAuth!.toolId);

          if (pendingConfig) {
            try {
              const authResult = await auth.openAndCheckAuth(pendingConfig);
              if (authResult.status === "awaiting_login") {
                authNextStep = authResult.message;
              } else {
                authNextStep = `${pendingConfig.name} is now authenticated. Call generate_image_candidates again to continue.`;
              }
            } catch {
              authNextStep = `${run.pendingAuth.toolName} needs login. Please open ${run.pendingAuth.url} and log in, then call ensure_auth('${run.pendingAuth.toolId}') to verify, then call generate_image_candidates again.`;
            }
          }
        }
      }

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
            review_page_path: reviewPagePath,
            review_images_dir: paths.imageDir,
            comparison_output_dir: paths.comparisonDir,
            auth_required: run.stage === "awaiting_auth" ? {
              tool_id: run.pendingAuth?.toolId,
              tool_name: run.pendingAuth?.toolName,
              url: run.pendingAuth?.url,
              reason: run.pendingAuth?.reason,
              next_step: authNextStep,
            } : undefined,
          },
        }) }],
      };
    },
  );
};
