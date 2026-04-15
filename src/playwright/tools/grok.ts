import path from "node:path";

import type { Download, Locator, Page } from "playwright";

import { imageToolConfigs } from "../../config/tools.js";
import { delay } from "../waits.js";
import { GenericImageToolAdapter } from "./base.js";

/**
 * Grok image-generation chrome.
 *
 * Grok renders each conversation turn into a `.message-bubble` container;
 * once an image-bearing assistant turn is sealed, Grok's own chrome attaches
 * a `button[aria-label='Download']` to the image tile (this is the button
 * the capture path has long relied on to save the artifact). The Download
 * affordance is image-specific — text-only replies don't render it — and it
 * appears only after the image bytes have resolved, making it a clean
 * tool-chrome completion signal.
 *
 * Mid-generation the composer shows a Stop control (either `Stop` text or
 * `aria-label="Stop"`); we treat its presence as a hard "not ready yet"
 * gate. This keys off DOM rendered by Grok's chrome, not model-authored
 * text, which is the whole point of this migration.
 */
class GrokToolAdapter extends GenericImageToolAdapter {
  protected override async hasCompletionAffordance(page: Page): Promise<boolean> {
    const signals = await page.evaluate(() => {
      // Mid-stream gate: Grok's composer renders a Stop control while the
      // turn is still streaming. Its presence means the stream has not
      // settled, so we can't trust any visible chrome yet.
      const stopActive = Array.from(document.querySelectorAll<HTMLElement>("button")).some((btn) => {
        const text = (btn.textContent ?? "").trim().toLowerCase();
        const aria = (btn.getAttribute("aria-label") ?? "").trim().toLowerCase();
        const isStop =
          text === "stop"
          || text === "stop generating"
          || aria === "stop"
          || aria === "stop generating";
        if (!isStop) return false;
        const rect = btn.getBoundingClientRect();
        const style = window.getComputedStyle(btn);
        return (
          rect.width > 0
          && rect.height > 0
          && style.display !== "none"
          && style.visibility !== "hidden"
          && style.opacity !== "0"
        );
      });

      if (stopActive) {
        return { ready: false, reason: "Stop control still active (stream running)" };
      }

      // Completion affordance: at least one visible Download button.
      // Grok only renders aria-label='Download' on sealed image tiles.
      const downloadButtons = Array.from(document.querySelectorAll<HTMLElement>("button[aria-label='Download']"))
        .filter((btn) => {
          const rect = btn.getBoundingClientRect();
          const style = window.getComputedStyle(btn);
          return (
            rect.width > 0
            && rect.height > 0
            && style.display !== "none"
            && style.visibility !== "hidden"
            && style.opacity !== "0"
          );
        });

      if (downloadButtons.length === 0) {
        return { ready: false, reason: "Download affordance not rendered yet" };
      }

      return {
        ready: true,
        reason: `${downloadButtons.length} visible Download button(s) on sealed image tile(s)`,
      };
    }).catch(() => ({ ready: false, reason: "evaluate failed" }));

    if (signals.ready) {
      console.error(`[Grok] completion-affordance: ${signals.reason}`);
    }
    return signals.ready;
  }

  protected override async waitForResultElements(page: Page, timeoutMs = 180_000): Promise<void> {
    await this.waitForCompletionAffordance(page, timeoutMs);
  }

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
