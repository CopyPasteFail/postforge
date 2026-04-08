import path from "node:path";

import type { Download, Locator, Page } from "playwright";

import { imageToolConfigs } from "../../config/tools.js";
import { waitForAnySelector } from "../waits.js";
import { GenericImageToolAdapter, ToolGenerationBlockedError } from "./base.js";

class ChatGptToolAdapter extends GenericImageToolAdapter {
  protected override async waitForResultElements(page: Page, timeoutMs = 90_000): Promise<void> {
    const deadline = Date.now() + timeoutMs;
    let rawParamsSeenAt: number | undefined;

    while (Date.now() < deadline) {
      const bodyText = await page.locator("body").textContent().catch(() => "") ?? "";
      const normalized = bodyText.toLowerCase();

      // Check for an explicit content block message (only NEW text, not leftover from a prior chat).
      if (this.isContentBlockedNew(normalized)) {
        throw new ToolGenerationBlockedError(
          "ChatGPT blocked the image request due to a copyright or compliance policy.",
          "copyright_block",
        );
      }

      // Detect when ChatGPT outputs the raw DALL-E parameters as text (silent failure/block).
      // Wait up to 20s for an image to appear — if none does, treat it as a failed generation.
      if (!rawParamsSeenAt && /\{"size"\s*:\s*"[\dx]+"/.test(bodyText)) {
        rawParamsSeenAt = Date.now();
        console.error("[ChatGPT] raw-dalle-params: Detected raw DALL-E parameters in response — waiting up to 20s for image");
      }
      if (rawParamsSeenAt && Date.now() - rawParamsSeenAt > 20_000) {
        console.error("[ChatGPT] raw-dalle-params-timeout: No image appeared after raw params — treating as silent generation failure");
        return;
      }

      // Check for a generated image stable across two ticks.
      const image = await this.findPrimaryImage(page);
      if (image) {
        await page.waitForTimeout(1_500).catch(() => undefined);
        const box = await image.boundingBox().catch(() => null);
        if (box && box.width >= 300 && box.height >= 200) {
          console.error(`[ChatGPT] result-ready: Detected stable generated image`);
          return;
        }
      }

      await page.waitForTimeout(1_500).catch(() => undefined);
    }

    // Final block check before giving up.
    const finalText = (await page.locator("body").textContent().catch(() => "") ?? "").toLowerCase();
    if (this.isContentBlockedNew(finalText)) {
      throw new ToolGenerationBlockedError(
        "ChatGPT blocked the image request due to a copyright or compliance policy.",
        "copyright_block",
      );
    }

    console.error(`[ChatGPT] result-ready-timeout: No stable generated image within ${Math.round(timeoutMs / 1_000)}s`);
  }

  private isContentBlockedNew(bodyText: string): boolean {
    const phrases = [
      "may violate our guardrails",
      "similarity to third-party content",
      "i wasn't able to generate",
      "i'm not able to generate",
      "i can't create this image",
      "i can't generate this image",
      "i cannot generate this image",
      "request violates our usage policies",
      "your request was rejected",
      "this prompt has been blocked",
      "copyrighted characters",
      "intellectual property rights",
      "i'm not able to help with that request",
    ];
    return phrases.some((phrase) => this.isNewText(bodyText, phrase));
  }

  protected override async captureResultElements(page: Page, outputDir: string): Promise<string[]> {
    const downloaded = await this.downloadFromChatGpt(page, outputDir);
    if (downloaded) {
      console.error(`[ChatGPT] result-saved: Downloaded image artifact ${downloaded}`);
      return [downloaded];
    }

    console.error("[ChatGPT] result-download-fallback: Falling back to generic media capture");
    return super.captureResultElements(page, outputDir);
  }

  private async downloadFromChatGpt(page: Page, outputDir: string): Promise<string | undefined> {
    const image = await this.findPrimaryImage(page);
    if (image) {
      await image.hover().catch(() => undefined);
      await page.waitForTimeout(500).catch(() => undefined);
    }

    for (const selector of this.downloadButtonSelectors()) {
      const button = page.locator(selector).first();
      const visible = (await button.count().catch(() => 0)) > 0 && await button.isVisible().catch(() => false);
      if (!visible) {
        continue;
      }

      console.error(`[ChatGPT] download-found: Using ${selector}`);
      const download = await this.clickAndCaptureDownload(page, button);
      if (!download) {
        continue;
      }

      const extension = this.extensionFromSuggestedFilename(download.suggestedFilename());
      const destination = path.join(outputDir, `chatgpt-result-1.${extension}`);
      await download.saveAs(destination);
      return destination;
    }

    return undefined;
  }

  private async findPrimaryImage(page: Page): Promise<Locator | undefined> {
    const selectors = [
      "article img",
      "main img",
      "img",
    ];

    for (const selector of selectors) {
      const locator = page.locator(selector);
      const count = await locator.count();
      for (let index = 0; index < Math.min(count, 8); index += 1) {
        const node = locator.nth(index);
        const visible = await node.isVisible().catch(() => false);
        if (!visible) {
          continue;
        }

        const box = await node.boundingBox().catch(() => null);
        if (!box || box.width < 300 || box.height < 200) {
          continue;
        }

        return node;
      }
    }

    return undefined;
  }

  private async clickAndCaptureDownload(page: Page, button: Locator): Promise<Download | undefined> {
    const downloadPromise = page.waitForEvent("download", { timeout: 20_000 }).catch(() => undefined);
    await button.click().catch(() => undefined);
    const download = await downloadPromise;
    if (download) {
      console.error(`[ChatGPT] download-clicked: Browser download started as ${download.suggestedFilename()}`);
    }
    return download;
  }

  private downloadButtonSelectors(): string[] {
    return [
      "button[aria-label='Download this image']",
      "button[aria-label*='Download this image']",
      "button[aria-label*='Download']",
      "button[title*='Download']",
      "[role='button'][aria-label*='Download']",
    ];
  }

  private extensionFromSuggestedFilename(filename: string): string {
    const extension = path.extname(filename).replace(/^\./, "").toLowerCase();
    return extension || "png";
  }
}

export const chatgptAdapter = new ChatGptToolAdapter(
  imageToolConfigs.find((tool) => tool.id === "chatgpt")!,
);
