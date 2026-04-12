import path from "node:path";

import { summarizeNextAction } from "./pipeline/checkpoints.js";
import type {
  DirectPipelineInput,
  ImageChoice,
  PipelineInput,
  RunRecord,
} from "./pipeline/types.js";
import type { ToolId } from "./config/tools.js";
import { inferStartInput } from "./source/parser.js";
import { ArticleSourceService } from "./source/article-source.js";
import { AssetStore } from "./storage/assets.js";
import { StateStore } from "./storage/state-store.js";
import { ImageRunnerAgent } from "./agents/image-runner.js";
import { LinkedInPreparerAgent } from "./agents/linkedin-preparer.js";
import { AuthRequiredError, CaptchaRequiredError } from "./playwright/auth.js";

const INACCESSIBLE_FALLBACK = "I can't access enough of that link to use it reliably. Please paste the exact article title and the relevant article text, and I'll draft from that only.";

export class OrchestratorAgent {
  /** Guards against concurrent generateImages calls for the same run (e.g. after MCP timeout + retry). */
  private readonly inFlightGenerations = new Map<string, Promise<RunRecord>>();

  public constructor(
    private readonly state = new StateStore(),
    private readonly sources = new ArticleSourceService(),
    private readonly imageRunner = new ImageRunnerAgent(),
    private readonly assets = new AssetStore(),
    private readonly linkedin = new LinkedInPreparerAgent(),
  ) {}

  public async startRun(input: PipelineInput): Promise<RunRecord> {
    const run = await this.state.createRun(input, "chat");
    return this.initializeRun(run.id, input);
  }

  public async submitApprovedCopy(runId: string, postText: string, imagePrompt: string): Promise<RunRecord> {
    return this.state.update(runId, (run) => {
      const trimmedPost = postText.trim();
      const trimmedPrompt = imagePrompt.trim();

      if (!trimmedPost) {
        throw new Error("Approved post text is empty.");
      }

      if (!trimmedPrompt) {
        throw new Error("Approved image prompt is empty.");
      }

      run.finalDraft = {
        postText: trimmedPost,
        copyBlock: `\`\`\`\n${trimmedPost}\n\`\`\``,
        followUpRevision: "Want to revise the draft? You can reply with one word like 'shorter', 'punchier', or 'clearer'.",
        followUpImage: "Want to move on to image generation? Reply 'image' or choose a comic style: Rick and Morty, Dilbert, The Jetsons, The Simpsons, South Park, Garfield, Futurama, X-Men, Lego, The Adventures of Tintin, Asterix and Obelix. You can also name another satire comic.",
        sourceLink: run.resolvedInput?.sourceLink ?? run.articleSource?.url,
      };

      run.finalImagePrompt = {
        promptText: trimmedPrompt,
        copyBlock: `\`\`\`\n${trimmedPrompt}\n\`\`\``,
        confirmationQuestion: "Generate this image?",
      };

      run.stage = "awaiting_image_generation";
      run.events.push(this.state.event("awaiting_image_generation", "Approved post and image prompt submitted."));
    });
  }

  public async generateImages(runId: string): Promise<RunRecord> {
    const existing = this.inFlightGenerations.get(runId);
    if (existing) {
      // Return current state immediately instead of joining the existing promise,
      // which would block until the full generation finishes and likely exceed the
      // MCP client timeout (120s).  The caller can poll via get_run or call
      // finalize_candidates when enough images have been captured.
      console.error(`[orchestrator] generateImages already in-flight for run ${runId} — returning current state instead of blocking.`);
      return this.state.load(runId);
    }

    const promise = this.doGenerateImages(runId);
    this.inFlightGenerations.set(runId, promise);
    try {
      return await promise;
    } finally {
      this.inFlightGenerations.delete(runId);
    }
  }

  private async doGenerateImages(runId: string): Promise<RunRecord> {
    const initialRun = await this.state.load(runId);
    if (!initialRun.finalImagePrompt) {
      throw new Error("Final image prompt is missing.");
    }

    try {
      await this.state.update(runId, (draft) => {
        draft.stage = "generating_images";
        draft.activeToolId = undefined;
        draft.activeToolName = undefined;
        draft.events.push(this.state.event("generating_images", "Image generation started."));
      });

      const result = await this.imageRunner.runAll(initialRun, true, {
        onToolStart: async (toolId, toolName) => {
          await this.state.update(runId, (draft) => {
            draft.stage = "generating_images";
            draft.activeToolId = toolId as RunRecord["activeToolId"];
            draft.activeToolName = toolName;
            draft.events.push(this.state.event("generating_images", `Processing ${toolName}.`));
          });
        },
        onToolComplete: async (asset) => {
          await this.state.update(runId, (draft) => {
            const existingIndex = draft.imageAssets.findIndex((item) => item.id === asset.id);
            if (existingIndex >= 0) {
              draft.imageAssets[existingIndex] = asset;
            } else {
              draft.imageAssets.push(asset);
            }
            draft.events.push(this.state.event("generating_images", `${asset.toolName} completed with status ${asset.status}.`));
          });
        },
      });

      return this.state.update(runId, (draft) => {
        draft.imageAssets = result.assets;
        draft.notes.push(`Image review file: ${result.reviewFile}`);
        draft.pendingAuth = undefined;
        draft.activeToolId = undefined;
        draft.activeToolName = undefined;
        draft.stage = "awaiting_image_selection";
        draft.events.push(this.state.event("awaiting_image_selection", "Image generation completed."));
      });
    } catch (error) {
      if (error instanceof AuthRequiredError || error instanceof CaptchaRequiredError) {
        return this.state.update(runId, (draft) => {
          draft.pendingAuth = error.checkpoint;
          draft.activeToolId = error.checkpoint.toolId;
          draft.activeToolName = error.checkpoint.toolName;
          draft.stage = "awaiting_auth";
          draft.events.push(this.state.event("awaiting_auth", error.checkpoint.reason));
        });
      }

      throw error;
    }
  }

  public async clearToolAsset(runId: string, toolId: string): Promise<RunRecord> {
    return this.state.update(runId, (draft) => {
      const index = draft.imageAssets.findIndex((a) => a.toolId === toolId);
      if (index < 0) throw new Error(`No asset found for tool: ${toolId}`);
      draft.imageAssets.splice(index, 1);
      draft.events.push(this.state.event(draft.stage, `${toolId} result cleared for retry.`));
    });
  }

  public async finalizeCandidates(runId: string): Promise<RunRecord> {
    const run = await this.state.load(runId);
    if (run.stage !== "generating_images" && run.stage !== "awaiting_auth") {
      throw new Error(`Cannot finalize candidates from stage: ${run.stage}`);
    }
    if (run.imageAssets.length === 0) {
      throw new Error("No image candidates have been generated yet.");
    }
    return this.state.update(runId, (draft) => {
      draft.pendingAuth = undefined;
      draft.activeToolId = undefined;
      draft.activeToolName = undefined;
      draft.stage = "awaiting_image_selection";
      draft.events.push(this.state.event("awaiting_image_selection", "Image generation finalized early by user request."));
    });
  }

  public async resumeAfterAuth(runId: string): Promise<RunRecord> {
    const run = await this.state.load(runId);
    if (!run.pendingAuth) {
      throw new Error("Run has no pending auth checkpoint.");
    }

    if (run.selectedImageAssetId) {
      return this.prepareLinkedIn(runId);
    }

    return this.generateImages(runId);
  }

  public async bypassPendingAuth(runId: string): Promise<RunRecord> {
    const run = await this.state.load(runId);
    if (!run.pendingAuth) {
      throw new Error("Run has no pending auth checkpoint.");
    }

    return this.skipTool(runId, run.pendingAuth.toolId, `${run.pendingAuth.toolName} skipped by user (no login).`);
  }

  public async skipTool(runId: string, toolId: string, reason?: string): Promise<RunRecord> {
    const run = await this.state.load(runId);
    const toolName = this.resolveToolName(toolId);
    const skipReason = reason ?? `${toolName} skipped by user.`;

    const skippedAsset = {
      id: `${runId}:${toolId}`,
      toolId: toolId as ToolId,
      toolName,
      status: "warning" as const,
      files: [] as string[],
      notes: skipReason,
    };
    const metadataPath = await this.assets.writeAssetMetadata(runId, skippedAsset);

    return this.state.update(runId, (draft) => {
      const existing = draft.imageAssets.findIndex((a) => a.id === skippedAsset.id);
      if (existing >= 0) {
        draft.imageAssets[existing] = { ...skippedAsset, metadataPath };
      } else {
        draft.imageAssets.push({ ...skippedAsset, metadataPath });
      }
      draft.events.push(this.state.event("awaiting_image_generation", `${toolName} skipped by user.`));
      if (draft.pendingAuth?.toolId === toolId) {
        draft.pendingAuth = undefined;
      }
      draft.activeToolId = undefined;
      draft.activeToolName = undefined;
      draft.stage = "awaiting_image_generation";
    });
  }

  private resolveToolName(toolId: string): string {
    const names: Record<string, string> = {
      chatgpt: "ChatGPT",
      gemini: "Gemini",
      "ai-studio": "AI Studio",
      flow: "Flow",
      grok: "Grok",
      copilot: "Copilot",
    };
    return names[toolId] ?? toolId;
  }

  public async pickImage(runId: string, assetId: string, variantId?: string): Promise<RunRecord> {
    const run = await this.state.load(runId);
    const choice = this.resolveImageChoice(run, assetId, variantId);
    const selectedImagePath = await this.assets.convertSelectedImage(runId, choice.filePath);

    return this.state.update(runId, (draft) => {
      draft.selectedImageAssetId = choice.assetId;
      draft.selectedImageVariantId = choice.variantId;
      draft.selectedImagePath = selectedImagePath;
      draft.stage = "ready_for_linkedin";
      draft.events.push(this.state.event("ready_for_linkedin", `Selected image ${choice.displayName} and saved ${selectedImagePath}.`));
    });
  }

  public async pickImageByNumber(runId: string, number: number): Promise<RunRecord> {
    const run = await this.state.load(runId);
    const choice = this.imageChoices(run).find((item) => item.number === number);
    if (!choice) {
      throw new Error(`Image choice not found: ${number}`);
    }

    return this.pickImage(runId, choice.assetId, choice.variantId);
  }

  public async prepareLinkedIn(runId: string): Promise<RunRecord> {
    const run = await this.state.load(runId);
    try {
      await this.linkedin.prepare(run);
      return this.state.update(runId, (draft) => {
        draft.pendingAuth = undefined;
        draft.stage = "ready_to_post";
        draft.events.push(this.state.event("ready_to_post", "LinkedIn composer prepared and ready for manual post click."));
      });
    } catch (error) {
      if (error instanceof AuthRequiredError) {
        return this.state.update(runId, (draft) => {
          draft.pendingAuth = error.checkpoint;
          draft.stage = "awaiting_auth";
          draft.events.push(this.state.event("awaiting_auth", error.checkpoint.reason));
        });
      }

      throw error;
    }
  }

  public async cancelRun(runId: string): Promise<RunRecord> {
    return this.state.update(runId, (run) => {
      run.stage = "archived";
      run.events.push(this.state.event("archived", "Run cancelled by user."));
    });
  }

  public async status(runId: string): Promise<{ run: RunRecord; nextAction: string; imageChoices?: ImageChoice[] }> {
    const run = await this.state.load(runId);
    const status = {
      run,
      nextAction: summarizeNextAction(run),
    };
    if (run.stage === "awaiting_image_selection") {
      return {
        ...status,
        imageChoices: this.imageChoices(run),
      };
    }

    return status;
  }

  public imageChoices(run: RunRecord): ImageChoice[] {
    let number = 1;
    const choices: ImageChoice[] = [];

    for (const asset of run.imageAssets) {
      if (asset.variants && asset.variants.length > 0) {
        for (const variant of asset.variants) {
          choices.push({
            number,
            assetId: asset.id,
            variantId: variant.id,
            filePath: variant.filePath,
            displayName: path.basename(variant.filePath),
          });
          number += 1;
        }
        continue;
      }

      for (const filePath of asset.files) {
        choices.push({
          number,
          assetId: asset.id,
          filePath,
          displayName: path.basename(filePath),
        });
        number += 1;
      }
    }

    return choices;
  }

  private async initializeRun(runId: string, input: DirectPipelineInput): Promise<RunRecord> {
    return this.state.update(runId, async (run) => {
      run.resolvedInput = input;

      if (input.kind === "link") {
        const articleSource = await this.sources.fetchFromLink(input.sourceLink);
        run.articleSource = articleSource;

        if (!articleSource.accessible) {
          run.stage = "blocked_on_source_access";
          run.notes.push(INACCESSIBLE_FALLBACK);
          run.events.push(this.state.event("blocked_on_source_access", articleSource.reason ?? "Source was not accessible."));
          return;
        }
      }

      run.stage = "awaiting_content_approval";
      run.events.push(this.state.event("awaiting_content_approval", "Run is ready for content drafting and approval."));
    });
  }

  private resolveImageChoice(run: RunRecord, assetId: string, variantId?: string): ImageChoice {
    const choice = this.imageChoices(run).find((item) => item.assetId === assetId && item.variantId === variantId);
    if (!choice) {
      throw new Error(variantId
        ? `Variant not found on asset ${assetId}: ${variantId}`
        : `Asset not found: ${assetId}`);
    }

    return choice;
  }
}
