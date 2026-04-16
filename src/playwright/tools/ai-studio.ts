import fs from "node:fs/promises";
import path from "node:path";

import type { Download, Locator, Page } from "playwright";

import { imageToolConfigs } from "../../config/tools.js";
import type { ImageAsset } from "../../pipeline/types.js";
import { delay, waitForAnySelector } from "../waits.js";
import { GenericImageToolAdapter, ToolGenerationBlockedError } from "./base.js";

class AiStudioToolAdapter extends GenericImageToolAdapter {
  private static readonly imageGenerationUrl = "https://aistudio.google.com/prompts/new_chat";

  protected override async configureMode(page: Page): Promise<void> {
    await this.openImageGeneration(page);
    await this.selectFreeNanoBanana(page);
  }

  public async downloadFromPromptUrl(runId: string, promptUrl: string, outputDir: string): Promise<ImageAsset> {
    await fs.mkdir(outputDir, { recursive: true });

    const { context, page } = await this.launchToolPage();
    try {
      console.error(`[${this.config.name}] navigating: Opening saved prompt ${promptUrl}`);
      await page.goto(promptUrl, { waitUntil: "domcontentloaded" });

      const isLoggedIn = await this.checkAuthenticated(page);
      if (!isLoggedIn) {
        await context.close();
        await this.ensureAuthenticated(true);
        return this.downloadFromPromptUrl(runId, promptUrl, outputDir);
      }

      const screenshotPath = path.join(outputDir, "ai-studio-existing-prompt.png");
      await page.screenshot({ path: screenshotPath, fullPage: true }).catch(() => undefined);

      const downloaded = await this.downloadGeneratedImage(page, outputDir);
      return {
        id: `${runId}:${this.config.id}`,
        toolId: this.config.id,
        toolName: this.config.name,
        status: downloaded ? "generated" : "warning",
        files: downloaded ? [downloaded] : [],
        screenshotPath,
        notes: downloaded
          ? `Downloaded image from existing AI Studio prompt ${promptUrl}.`
          : `Opened existing AI Studio prompt ${promptUrl}, but could not find a downloadable generated image.`,
      };
    } finally {
      await context.close().catch(() => undefined);
    }
  }

  protected override async captureResultElements(page: Page, outputDir: string): Promise<string[]> {
    const downloaded = await this.downloadGeneratedImage(page, outputDir);
    if (downloaded) {
      console.error(`[${this.config.name}] result-saved: Downloaded full-size image artifact ${downloaded}`);
      return [downloaded];
    }

    return super.captureResultElements(page, outputDir);
  }

  /**
   * AI Studio renders a `div.turn-footer` inside `ms-chat-turn` ONLY
   * after the turn is sealed (it's Angular `*ngIf`-conditional on the
   * run being finished).
   *
   * Previously we relied on `.model-run-time-pill` (a duration badge like
   * "45.799s") inside that footer, but AI Studio removed it from the UI
   * in an April 2026 update. The footer now only contains the "Good
   * response" / "Bad response" feedback buttons (`.response-feedback-button`)
   * and the "Rerun this turn" button — all of which are Angular-conditional
   * on the turn being sealed and are therefore equally reliable as a
   * completion signal.
   *
   * Verified live against aistudio.google.com on 2026-04-16.
   *
   * For image-generation mode (Nano Banana) we additionally require a
   * visible image in the last turn; a sealed turn with only text means
   * the model refused or produced a thoughts-only response and we need
   * to trigger a rerun.
   */
  protected override async hasCompletionAffordance(page: Page): Promise<boolean> {
    const sealed = await page.evaluate(() => {
      const turns = document.querySelectorAll("ms-chat-turn");
      const lastTurn = turns[turns.length - 1];
      if (!lastTurn) return false;
      // Feedback buttons (.response-feedback-button) are rendered by Angular
      // *ngIf only once the turn is fully sealed — their presence is the
      // canonical completion signal after the model-run-time-pill was removed.
      return !!lastTurn.querySelector(".turn-footer .response-feedback-button");
    }).catch(() => false);
    if (sealed) {
      console.error(`[${this.config.name}] completion-affordance: .response-feedback-button present in turn-footer of last turn`);
    }
    return sealed;
  }

  protected override async waitForResultElements(page: Page, timeoutMs = 120_000): Promise<void> {
    const effectiveTimeout = Math.max(timeoutMs, 180_000);
    const maxReruns = 3;
    let rerunAttempts = 0;

    const deadline = Date.now() + effectiveTimeout;
    while (Date.now() < deadline) {
      await this.scrollToBottom(page);

      // Content-block / transient-error banners are tool chrome (AI
      // Studio's own error surface), not model output, so text matching
      // is correct here.
      if (await this.isContentBlocked(page)) {
        throw new ToolGenerationBlockedError(
          "Image could not be produced due to a copyright or content block from AI Studio.",
          "copyright_block",
        );
      }

      if (await this.hasTransientError(page) && rerunAttempts < maxReruns) {
        console.error(`[${this.config.name}] transient-error: Detected transient failure, attempting rerun (${rerunAttempts + 1}/${maxReruns})`);
        if (await this.tryRerunTurn(page)) {
          rerunAttempts += 1;
          await delay(3_000);
          continue;
        }
      }

      if (await this.hasCompletionAffordance(page)) {
        // Turn is sealed. For image mode, verify an image landed in the
        // last turn — if not, the model went off-task (e.g. emitted only
        // thoughts text); trigger a rerun if we have budget.
        if (await this.findGeneratedImage(page)) {
          return;
        }

        if (rerunAttempts < maxReruns && await this.tryRerunTurn(page)) {
          console.error(`[${this.config.name}] sealed-without-image: rerunning (${rerunAttempts + 1}/${maxReruns})`);
          rerunAttempts += 1;
          await delay(2_000);
          continue;
        }

        // Out of rerun budget. Return so the caller can see whatever
        // screenshot / artifacts exist; captureResultElements will
        // report `warning` if no image was found.
        return;
      }

      await delay(1_000);
    }

    // Timed out. Re-check blocks one last time in case the banner arrived
    // at the deadline.
    if (await this.isContentBlocked(page)) {
      throw new ToolGenerationBlockedError(
        "Image could not be produced due to a copyright or content block from AI Studio.",
        "copyright_block",
      );
    }
  }

  private async openImageGeneration(page: Page): Promise<void> {
    const bodyText = await page.locator("body").textContent().catch(() => "") ?? "";
    if (
      !page.url().includes("/prompts/new_chat")
      || bodyText.toLowerCase().includes("the specified model was not recognized")
    ) {
      await page.goto(AiStudioToolAdapter.imageGenerationUrl, { waitUntil: "domcontentloaded" }).catch(() => undefined);
      await delay(2_000);
    }

    if (await this.isNanoBananaSelected(page)) {
      return;
    }

    const tileSelectors = [
      "div[role='button']:has-text('Image Generation')",
      "button:has-text('Image Generation')",
      "a:has-text('Image Generation')",
      "div:has(> div:text-is('Image Generation'))",
      "text=Image Generation",
    ];

    const tileSelector = await waitForAnySelector(page, tileSelectors, 5_000);
    if (tileSelector) {
      const tile = page.locator(tileSelector).first();
      await tile.scrollIntoViewIfNeeded().catch(() => undefined);
      await tile.click().catch(() => undefined);
      await delay(2_000);
      if (await this.isNanoBananaSelected(page) || await this.waitForComposer(page, 2_000)) {
        return;
      }
    }

    const selector = await waitForAnySelector(page, [
      "div[role='button']:has-text('Image Generation')",
      "button:has-text('Image Generation')",
      "a:has-text('Image Generation')",
      "text=Image Generation",
    ], 15_000);

    if (!selector) {
      return;
    }

    const target = page.locator(selector).first();
    await target.scrollIntoViewIfNeeded().catch(() => undefined);
    await target.click().catch(() => undefined);
    await delay(2_000);
  }

  private async selectFreeNanoBanana(page: Page): Promise<void> {
    await waitForAnySelector(page, [
      "text=Nano Banana",
      "text=gemini-2.5-flash-image",
      "text=Image Generation",
    ], 15_000).catch(() => undefined);

    if (await this.isNanoBananaSelected(page)) {
      return;
    }

    const row = await this.findExactNanoBananaRow(page);
    if (row) {
      await row.scrollIntoViewIfNeeded().catch(() => undefined);
      await row.click().catch(() => undefined);
      await delay(1_000);
    }

    if (await this.isNanoBananaSelected(page) || await this.waitForComposer(page, 4_000)) {
      return;
    }

    const title = page.getByText("Nano Banana", { exact: true }).first();
    if (await title.isVisible().catch(() => false)) {
      await title.scrollIntoViewIfNeeded().catch(() => undefined);
      await title.click().catch(() => undefined);
      await delay(1_500);
    }

    if (await this.isNanoBananaSelected(page) || await this.waitForComposer(page, 4_000)) {
      return;
    }

    await this.tryExactNanoBananaActions(page);
  }

  private async isNanoBananaSelected(page: Page): Promise<boolean> {
    const candidates = [
      "button:has-text('Nano Banana'):has-text('gemini-2.5-flash-image')",
      "button:has-text('Nano Banana')",
      "text=gemini-2.5-flash-image",
    ];

    for (const selector of candidates) {
      const locator = page.locator(selector).first();
      if (await locator.isVisible().catch(() => false)) {
        return true;
      }
    }

    return false;
  }

  private async findExactNanoBananaRow(page: Page): Promise<Locator | undefined> {
    const exactTitle = page.getByText("Nano Banana", { exact: true }).first();
    if (!(await exactTitle.isVisible().catch(() => false))) {
      return undefined;
    }

    const row = exactTitle.locator("xpath=ancestor-or-self::div[count(.//button) >= 1][1]");
    if (await row.isVisible().catch(() => false)) {
      return row;
    }

    return exactTitle;
  }

  private async tryExactNanoBananaActions(page: Page): Promise<void> {
    const row = await this.findExactNanoBananaRow(page);
    if (!row) {
      return;
    }

    const buttons = row.locator("button, [role='button']");
    const count = await buttons.count().catch(() => 0);
    for (let index = count - 1; index >= 0; index -= 1) {
      const button = buttons.nth(index);
      const visible = await button.isVisible().catch(() => false);
      if (!visible) {
        continue;
      }

      await button.scrollIntoViewIfNeeded().catch(() => undefined);
      await button.click().catch(() => undefined);
      await delay(1_500);
      if (await this.waitForComposer(page, 3_000)) {
        return;
      }
    }
  }

  private async waitForComposer(page: Page, timeoutMs: number): Promise<boolean> {
    const selectors = [
      "textarea[placeholder*='Start typing a prompt']",
      "textarea[aria-label*='prompt']",
      "textarea",
      "div[contenteditable='true'][role='textbox']",
      "div[contenteditable='true']",
    ];

    if (await waitForAnySelector(page, selectors, timeoutMs)) {
      return true;
    }

    await page.evaluate(() => window.scrollTo({ top: document.body.scrollHeight, behavior: "instant" })).catch(() => undefined);
    await delay(500);
    if (await waitForAnySelector(page, selectors, Math.min(timeoutMs, 2_000))) {
      return true;
    }

    await page.keyboard.press("End").catch(() => undefined);
    await delay(500);
    return Boolean(await waitForAnySelector(page, selectors, Math.min(timeoutMs, 2_000)));
  }

  private async downloadGeneratedImage(page: Page, outputDir: string): Promise<string | undefined> {
    await this.scrollToBottom(page);
    const image = await this.findGeneratedImage(page);
    if (!image) {
      return undefined;
    }

    await image.scrollIntoViewIfNeeded().catch(() => undefined);
    await image.hover().catch(() => undefined);
    await delay(1_000);

    const downloadButton = await this.findDownloadButton(page, image);
    if (!downloadButton) {
      return undefined;
    }

    const download = await this.clickAndWaitForDownload(page, downloadButton);
    if (!download) {
      return undefined;
    }

    const suggestedFilename = download.suggestedFilename();
    const filePath = path.join(outputDir, suggestedFilename);
    await download.saveAs(filePath);
    return filePath;
  }

  private async findGeneratedImage(page: Page): Promise<Locator | undefined> {
    await this.scrollToBottom(page);
    const candidates = [
      page.locator("img[alt*='Generated Image']").first(),
      page.locator("img[alt$='.png']").first(),
      page.locator("img").last(),
      page.locator("canvas").last(),
    ];

    for (const candidate of candidates) {
      const visible = await candidate.isVisible().catch(() => false);
      if (visible) {
        return candidate;
      }
    }

    return undefined;
  }

  private async isContentBlocked(page: Page): Promise<boolean> {
    const bodyText = await page.locator("body").textContent().catch(() => "") ?? "";
    const normalized = bodyText.toLowerCase();
    return normalized.includes("content blocked")
      || normalized.includes("request blocked")
      || normalized.includes("safety blocked")
      || normalized.includes("copyright")
      || normalized.includes("third-party content");
  }

  private async scrollToBottom(page: Page): Promise<void> {
    await page.evaluate(() => {
      const root = document.scrollingElement ?? document.documentElement ?? document.body;
      root.scrollTo({ top: root.scrollHeight, behavior: "instant" });
    }).catch(() => undefined);
    await page.keyboard.press("End").catch(() => undefined);
    await delay(500);
  }

  private async findDownloadButton(page: Page, image: Locator): Promise<Locator | undefined> {
    const selectors = [
      "button[aria-label*='Download']",
      "button:has-text('Download')",
    ];

    // First pass — check without hover (button may already be visible).
    for (const selector of selectors) {
      const globalButton = page.locator(selector).first();
      if (await globalButton.isVisible().catch(() => false)) {
        return globalButton;
      }
    }

    // AI Studio hides the download button behind a hover overlay.
    // Hover the image, wait for the overlay to appear, then retry.
    await image.hover().catch(() => undefined);
    await delay(800);

    for (const selector of selectors) {
      const globalButton = page.locator(selector).first();
      if (await globalButton.isVisible().catch(() => false)) {
        return globalButton;
      }
    }

    return undefined;
  }

  private async clickAndWaitForDownload(page: Page, button: Locator): Promise<Download | undefined> {
    const downloadPromise = page.waitForEvent("download", { timeout: 30_000 }).catch(() => undefined);
    await button.click().catch(() => undefined);
    return downloadPromise;
  }

  private async hasTransientError(page: Page): Promise<boolean> {
    const bodyText = await page.locator("body").textContent().catch(() => "") ?? "";
    const normalized = bodyText.toLowerCase();
    return normalized.includes("an internal error has occurred")
      || normalized.includes("failed to generate content: permission denied")
      || normalized.includes("permission denied")
      || normalized.includes("something went wrong. please try again")
      || normalized.includes("unable to process your request");
  }

  private async hoverLastModelResponse(page: Page): Promise<void> {
    const selectors = [
      "ms-chat-turn",
      "[class*='chat-turn']",
      "[class*='model-response']",
      "[class*='response-container']",
      "[class*='conversation-turn']",
      "[data-message-role='model']",
      "[data-turn]",
    ];

    for (const selector of selectors) {
      const elements = page.locator(selector);
      const count = await elements.count().catch(() => 0);
      if (count > 0) {
        const last = elements.last();
        if (await last.isVisible().catch(() => false)) {
          await last.hover().catch(() => undefined);
          return;
        }
      }
    }

    // Fallback: move the mouse to the lower-center of the viewport to trigger
    // hover-reveal on whichever response is visible at the bottom of the page.
    const viewport = page.viewportSize();
    if (viewport) {
      await page.mouse.move(viewport.width * 0.5, viewport.height * 0.65).catch(() => undefined);
    }
  }

  private async tryRerunTurn(page: Page): Promise<boolean> {
    await this.hoverLastModelResponse(page);
    await delay(1_000);

    const rerunSelectors = [
      "button[aria-label='Rerun this turn']",
      "button[aria-label*='Rerun this turn']",
      "button[aria-label*='Rerun']",
      "button[title*='Rerun this turn']",
      "button[title*='Rerun']",
      "button:has-text('Rerun this turn')",
      "button:has-text('Rerun')",
    ];

    for (const selector of rerunSelectors) {
      const button = page.locator(selector).first();
      if (await button.isVisible().catch(() => false)) {
        await button.click().catch(() => undefined);
        await delay(1_500);
        return true;
      }
    }

    // Angular Material hides action buttons behind CSS opacity/visibility until
    // hover — use JS to find and click the rerun button regardless of visual state.
    const clicked = await page.evaluate(() => {
      const allButtons = Array.from(document.querySelectorAll<HTMLElement>("button, [role='button']"));
      for (const el of allButtons) {
        const label = (el.getAttribute("aria-label") ?? "").toLowerCase();
        const title = (el.getAttribute("title") ?? "").toLowerCase();
        const text = (el.textContent ?? "").toLowerCase().trim();
        if (label.includes("rerun") || title.includes("rerun") || text === "rerun this turn") {
          el.click();
          return true;
        }
      }
      return false;
    }).catch(() => false);

    if (clicked) {
      await delay(1_500);
      return true;
    }

    // Try overflow menu: look for a "More options"-style button near the response.
    const overflowButton = page.locator([
      "button[aria-label*='More options']",
      "button[aria-label*='More actions']",
      "button[aria-label='Open menu']",
      "button[aria-label*='more' i]",
    ].join(", ")).last();

    if (!(await overflowButton.isVisible().catch(() => false))) {
      return false;
    }

    await overflowButton.click().catch(() => undefined);
    await delay(600);

    for (const selector of [
      "[role='menuitem']:has-text('Rerun this turn')",
      "[role='menuitem']:has-text('Rerun')",
      "button:has-text('Rerun this turn')",
      "button:has-text('Rerun')",
      "text=Rerun this turn",
    ]) {
      const item = page.locator(selector).first();
      if (await item.isVisible().catch(() => false)) {
        await item.click().catch(() => undefined);
        await delay(1_500);
        return true;
      }
    }

    // No Rerun item in this overflow menu (likely because the turn already
    // has an image and we raced the completion signal). Close the menu so
    // it doesn't linger over the composer / capture path.
    await page.keyboard.press("Escape").catch(() => undefined);
    return false;
  }
}

export const aiStudioAdapter = new AiStudioToolAdapter(
  imageToolConfigs.find((tool) => tool.id === "ai-studio")!,
);
