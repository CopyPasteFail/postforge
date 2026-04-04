import path from "node:path";

import type { Download, Locator, Page } from "playwright";

import { imageToolConfigs } from "../../config/tools.js";
import { delay, waitForAnySelector } from "../waits.js";
import { GenericImageToolAdapter, ToolGenerationBlockedError } from "./base.js";

class GeminiToolAdapter extends GenericImageToolAdapter {
  protected override async configureMode(page: Page): Promise<void> {
    // Gemini defaults to chat mode. Click "Create image" to switch to image generation.
    const createImageSelector = await waitForAnySelector(page, [
      "button:has-text('Create image')",
      "a:has-text('Create image')",
      "[aria-label*='Create image']",
    ], 4_000);

    if (createImageSelector) {
      console.error("[Gemini] configureMode: clicking Create image button");
      await page.locator(createImageSelector).first().click().catch(() => undefined);
      await delay(2_000);
    } else {
      console.error("[Gemini] configureMode: Create image button not found, proceeding without mode switch");
    }
  }

  protected override async waitForResultElements(page: Page, timeoutMs = 120_000): Promise<void> {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      const bodyText = await page.locator("body").textContent().catch(() => "") ?? "";
      const normalized = bodyText.toLowerCase();
      if (
        normalized.includes("image generation request denied")
        || normalized.includes("due to interests of third-party content providers")
        || normalized.includes("please edit your prompt and try again")
      ) {
        throw new ToolGenerationBlockedError(
          "Image could not be produced due to a copyright block from Gemini.",
          "copyright_block",
        );
      }

      const image = page.locator("img.image.loaded, img[alt*='AI generated']").first();
      if (await image.count().catch(() => 0)) {
        await super.waitForResultElements(page, Math.max(5_000, deadline - Date.now()));
        if (await image.count().catch(() => 0)) {
          await image.hover().catch(() => undefined);
        }

        const actionSelector = await waitForAnySelector(page, this.downloadButtonSelectors(), 10_000);
        if (actionSelector) {
          console.error(`[Gemini] result-action-ready: Download control visible via ${actionSelector}`);
        }
        return;
      }

      await delay(1_500);
    }

    // No Gemini-specific image found within timeout — captureResultElements will return 0 files.
    console.error("[Gemini] waitForResultElements: no image detected within timeout");
  }

  protected override async captureResultElements(page: Page, outputDir: string): Promise<string[]> {
    const downloaded = await this.downloadFromGemini(page, outputDir);
    if (downloaded) {
      console.error(`[Gemini] result-saved: Downloaded image artifact ${downloaded}`);
      return [downloaded];
    }

    console.error("[Gemini] result-download-fallback: Falling back to generic media capture");
    return super.captureResultElements(page, outputDir);
  }

  private async downloadFromGemini(page: Page, outputDir: string): Promise<string | undefined> {
    const image = page.locator("img.image.loaded, img[alt*='AI generated']").first();
    if (await image.count().catch(() => 0)) {
      await image.hover().catch(() => undefined);
      await image.click().catch(() => undefined);
      await page.waitForTimeout(500).catch(() => undefined);
    }

    for (const selector of this.downloadButtonSelectors()) {
      const button = page.locator(selector).first();
      const visible = (await button.count().catch(() => 0)) > 0 && await button.isVisible().catch(() => false);
      if (!visible) {
        continue;
      }

      console.error(`[Gemini] download-found: Using ${selector}`);
      const download = await this.clickAndCaptureDownload(page, button);
      if (!download) {
        continue;
      }

      const extension = this.extensionFromSuggestedFilename(download.suggestedFilename());
      const destination = path.join(outputDir, `gemini-result-1.${extension}`);
      await download.saveAs(destination);
      return destination;
    }

    return undefined;
  }

  private async clickAndCaptureDownload(page: Page, button: Locator): Promise<Download | undefined> {
    const downloadPromise = page.waitForEvent("download", { timeout: 20_000 }).catch(() => undefined);
    await button.click().catch(() => undefined);
    const download = await downloadPromise;
    if (download) {
      console.error(`[Gemini] download-clicked: Browser download started as ${download.suggestedFilename()}`);
    }
    return download;
  }

  private downloadButtonSelectors(): string[] {
    return [
      "button:has(mat-icon[fonticon='download'])",
      "button:has(mat-icon[data-mat-icon-name='download'])",
      "[role='button']:has(mat-icon[fonticon='download'])",
      "[role='button']:has(mat-icon[data-mat-icon-name='download'])",
      "button[aria-label*='Download']",
      "button[aria-label*='download']",
      "button[title*='Download']",
      "button[title*='download']",
      "[role='button'][aria-label*='Download']",
      "[role='button'][aria-label*='download']",
    ];
  }

  private extensionFromSuggestedFilename(filename: string): string {
    const extension = path.extname(filename).replace(/^\./, "").toLowerCase();
    return extension || "png";
  }
}

export const geminiAdapter = new GeminiToolAdapter(
  imageToolConfigs.find((tool) => tool.id === "gemini")!,
);
