import path from "node:path";

import type { Download, Locator, Page } from "playwright";

import { imageToolConfigs } from "../../config/tools.js";
import { delay } from "../waits.js";
import { GenericImageToolAdapter } from "./base.js";

class GrokToolAdapter extends GenericImageToolAdapter {
  protected override async captureResultElements(page: Page, outputDir: string): Promise<string[]> {
    const downloaded = await this.downloadVisibleResult(page, outputDir);
    if (downloaded) {
      console.error(`[Grok] result-saved: Downloaded image artifact ${downloaded}`);
      return [downloaded];
    }

    return super.captureResultElements(page, outputDir);
  }

  private async downloadVisibleResult(page: Page, outputDir: string): Promise<string | undefined> {
    const downloadButton = page.locator("button[aria-label='Download']").first();
    const visible = await downloadButton.isVisible().catch(() => false);
    if (!visible) {
      return undefined;
    }

    const download = await this.clickAndWaitForDownload(page, downloadButton);
    if (!download) {
      return undefined;
    }

    const suggested = download.suggestedFilename();
    const target = path.join(outputDir, suggested);
    await download.saveAs(target);
    return target;
  }

  private async clickAndWaitForDownload(page: Page, target: Locator): Promise<Download | undefined> {
    const downloadPromise = page.waitForEvent("download", { timeout: 30_000 }).catch(() => undefined);
    await target.click().catch(() => undefined);
    await delay(500);
    return downloadPromise;
  }
}

export const grokAdapter = new GrokToolAdapter(
  imageToolConfigs.find((tool) => tool.id === "grok")!,
);
