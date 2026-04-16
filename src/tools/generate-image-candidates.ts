import path from "node:path";
import { pathToFileURL } from "node:url";

import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";

import { OrchestratorAgent } from "../orchestrator.js";
import { runPaths } from "../config/paths.js";
import { imageToolConfigs, linkedInConfig } from "../config/tools.js";
import { AuthService } from "../playwright/auth.js";
import { allowedActionsForStage, extractReviewPagePath } from "./helpers.js";

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

      // When the orchestrator returns while generation is still in-flight
      // (e.g. another MCP call already started it), inform the caller to poll
      // instead of blocking until the full generation completes.
      const stillGenerating = run.stage === "generating_images" && run.activeToolId;
      if (stillGenerating) {
        const completedSoFar = run.imageAssets.filter((a) => a.status === "generated");
        return {
          content: [{ type: "text" as const, text: JSON.stringify({
            run_id: run.id,
            stage: run.stage,
            allowed_actions: allowedActionsForStage(run.stage),
            idempotent: true,
            data: {
              next_action: `Image generation is still running on ${run.activeToolName}. ${completedSoFar.length} tool(s) completed so far. Use get_run to poll for progress, or call finalize_candidates to stop early and choose from what is ready.`,
              candidates_so_far: completedSoFar.map((asset, index) => ({
                number: index + 1,
                tool_id: asset.toolId,
                tool_name: asset.toolName,
                status: asset.status,
                file_path: asset.files[0],
                file_url: toFileUrl(asset.files[0]),
                display_name: asset.files[0] ? path.basename(asset.files[0]) : undefined,
                notes: asset.notes,
              })),
              active_tool: run.activeToolName,
            },
          }) }],
        };
      }

      const candidates = run.imageAssets.map((asset, index) => ({
        number: index + 1,
        tool_id: asset.toolId,
        tool_name: asset.toolName,
        status: asset.status,
        file_path: asset.files[0],
        display_name: asset.files[0] ? path.basename(asset.files[0]) : undefined,
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
              ? orchestrator.imageChoices(run).map((c) => {
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
              })
              : candidates,
            review_page_path: reviewPagePath,
            review_page_url: toFileUrl(reviewPagePath),
            review_images_dir: paths.imageDir,
            review_images_dir_url: toFileUrl(paths.imageDir),
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
