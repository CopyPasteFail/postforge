import { aiStudioAdapter } from "../playwright/tools/ai-studio.js";
import { chatgptAdapter } from "../playwright/tools/chatgpt.js";
import { copilotAdapter } from "../playwright/tools/copilot.js";
import { flowAdapter } from "../playwright/tools/flow.js";
import { geminiAdapter } from "../playwright/tools/gemini.js";
import { grokAdapter } from "../playwright/tools/grok.js";
import { ReviewManifestBuilder } from "../review/manifest.js";
import { AssetStore } from "../storage/assets.js";
import type { ImageAsset, RunRecord } from "../pipeline/types.js";
import { ToolGenerationBlockedError, type ToolAdapter } from "../playwright/tools/base.js";

const adapters: ToolAdapter[] = [
  chatgptAdapter,
  geminiAdapter,
  aiStudioAdapter,
  flowAdapter,
  grokAdapter,
  copilotAdapter,
];

const toolEnabled = (toolId: ToolAdapter["config"]["id"]): boolean => {
  const envKey = `IMAGE_TOOL_${toolId.replace(/-/g, "_").toUpperCase()}_ENABLED`;
  const configured = process.env[envKey];
  if (configured != null) {
    return /^true$/i.test(configured);
  }

  if (toolId === "grok") {
    return false;
  }

  return true;
};

export class ImageRunnerAgent {
  public constructor(
    private readonly assets = new AssetStore(),
    private readonly manifestBuilder = new ReviewManifestBuilder(),
  ) {}

  public async runAll(
    run: RunRecord,
    interactive = true,
    callbacks?: {
      onToolStart?: (toolId: string, toolName: string) => Promise<void> | void;
      onToolComplete?: (asset: ImageAsset) => Promise<void> | void;
    },
  ): Promise<{ assets: ImageAsset[]; reviewFile: string }> {
    if (!run.finalImagePrompt) {
      throw new Error("Run is missing a final image prompt.");
    }

    await this.assets.resetRunArtifacts(run.id);
    await this.assets.ensureRunDirs(run.id);

    const pending = adapters.filter((adapter) => toolEnabled(adapter.config.id));

    const fulfilledAssets: ImageAsset[] = [];
    for (const adapter of pending) {
      await callbacks?.onToolStart?.(adapter.config.id, adapter.config.name);

      try {
        await adapter.ensureAuthenticated(interactive);
        const outputDir = await this.assets.ensureToolDir(run.id, adapter.config.id);
        const generatedAsset = await adapter.generate(run.id, run.finalImagePrompt.promptText, outputDir, false);
        const asset = await this.assets.finalizeAsset(run.id, generatedAsset);
        const metadataPath = await this.assets.writeAssetMetadata(run.id, asset);
        const enrichedAsset = {
          ...asset,
          metadataPath,
        };
        fulfilledAssets.push(enrichedAsset);
        await callbacks?.onToolComplete?.(enrichedAsset);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        const notes = error instanceof ToolGenerationBlockedError
          ? message
          : `${adapter.config.name} did not complete automatically: ${message}`;
        const warningAsset: ImageAsset = {
          id: `${run.id}:${adapter.config.id}`,
          toolId: adapter.config.id,
          toolName: adapter.config.name,
          status: "warning",
          files: [],
          notes,
        };
        const metadataPath = await this.assets.writeAssetMetadata(run.id, warningAsset);
        const enrichedAsset = {
          ...warningAsset,
          metadataPath,
        };
        fulfilledAssets.push(enrichedAsset);
        await callbacks?.onToolComplete?.(enrichedAsset);
      }
    }

    const mergedAssets = [...fulfilledAssets].reduce<ImageAsset[]>((accumulator, asset) => {
      const existingIndex = accumulator.findIndex((item) => item.id === asset.id);
      if (existingIndex >= 0) {
        accumulator[existingIndex] = asset;
      } else {
        accumulator.push(asset);
      }
      return accumulator;
    }, []);

    const reviewFile = await this.manifestBuilder.build(run.id, mergedAssets);
    return { assets: mergedAssets, reviewFile };
  }
}
