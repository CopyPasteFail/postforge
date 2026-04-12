import { LinkedInAdapter } from "../playwright/tools/linkedin.js";
import type { RunRecord } from "../pipeline/types.js";
import path from "node:path";
import { exec } from "node:child_process";

export class LinkedInPreparerAgent {
  public constructor(private readonly adapter = new LinkedInAdapter()) {}

  public async prepare(run: RunRecord): Promise<void> {
    if (!run.finalDraft) {
      throw new Error("Cannot prepare LinkedIn without a final draft.");
    }

    if (!run.selectedImageAssetId && !run.selectedImagePath) {
      throw new Error("Cannot prepare LinkedIn without a selected image.");
    }

    // Always use interactive=false in MCP mode so that an auth failure
    // throws AuthRequiredError immediately instead of entering a long
    // polling loop that exceeds the MCP client timeout.
    const interactive = false;

    if (run.selectedImagePath) {
      this.openImageFolder(run.selectedImagePath);
      await this.adapter.prepareTextOnly(run.finalDraft.postText, interactive);
      return;
    }

    const asset = run.imageAssets.find((item) => item.id === run.selectedImageAssetId);
    if (!asset || asset.files.length === 0) {
      throw new Error("Selected image asset has no captured image files.");
    }

    const selectedVariantFile = run.selectedImageVariantId
      ? asset.variants?.find((item) => item.id === run.selectedImageVariantId)?.filePath
      : undefined;

    const imagePath = selectedVariantFile ?? asset.files[0]!;
    this.openImageFolder(imagePath);
    await this.adapter.prepareTextOnly(run.finalDraft.postText, interactive);
  }

  private openImageFolder(imagePath: string): void {
    const folderPath = path.dirname(imagePath);
    const platform = process.platform;
    if (platform === "win32") {
      exec(`explorer.exe "${folderPath}"`);
    } else if (platform === "darwin") {
      exec(`open "${folderPath}"`);
    } else {
      exec(`xdg-open "${folderPath}"`);
    }
  }
}
