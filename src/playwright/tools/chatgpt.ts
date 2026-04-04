import path from "node:path";

import type { Download, Locator, Page } from "playwright";

import { imageToolConfigs } from "../../config/tools.js";
import { waitForAnySelector } from "../waits.js";
import { GenericImageToolAdapter } from "./base.js";

class ChatGptToolAdapter extends GenericImageToolAdapter {
  protected override async waitForResultElements(page: Page, timeoutMs = 180_000): Promise<void> {
    await super.waitForResultElements(page, timeoutMs);

    const image = await this.findPrimaryImage(page);
    if (!image) {
      return;
    }

    await image.hover().catch(() => undefined);
    const downloadSelector = await waitForAnySelector(page, this.downloadButtonSelectors(), 10_000);
    if (downloadSelector) {
      console.log(`[ChatGPT] result-action-ready: Download control visible via ${downloadSelector}`);
    }
  }

  protected override async captureResultElements(page: Page, outputDir: string): Promise<string[]> {
    const downloaded = await this.downloadFromChatGpt(page, outputDir);
    if (downloaded) {
      console.log(`[ChatGPT] result-saved: Downloaded image artifact ${downloaded}`);
      return [downloaded];
    }

    console.log("[ChatGPT] result-download-fallback: Falling back to generic media capture");
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

      console.log(`[ChatGPT] download-found: Using ${selector}`);
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
      console.log(`[ChatGPT] download-clicked: Browser download started as ${download.suggestedFilename()}`);
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
