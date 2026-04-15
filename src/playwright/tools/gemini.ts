import fs from "node:fs/promises";
import path from "node:path";

import type { Download, Locator, Page } from "playwright";

import { imageToolConfigs } from "../../config/tools.js";
import { delay, waitForAnySelector } from "../waits.js";
import { GenericImageToolAdapter, ToolGenerationBlockedError } from "./base.js";

/**
 * Gemini image-generation chrome (verified live against gemini.google.com on
 * 2026-04-14).
 *
 * Each assistant turn is wrapped in a `<model-response>` Angular custom
 * element; each user turn is `<user-query>`. While an image is being
 * generated, Gemini renders `<mat-progress-spinner>` inside the last
 * `<model-response>` and the model response text is "Creating your
 * image..." — we do NOT key off that text, because it is model-authored.
 *
 * Once the image is sealed, the last `<model-response>` gets a stable action
 * bar rendered by Gemini's own chrome:
 *   - `button[data-test-id='download-generated-image-button']` (aria "Download full size image")
 *   - `button[data-test-id='share-button']`                     (aria "Share image")
 *   - `button[data-test-id='regenerate-button']`                (aria "Redo")
 *   - `button[data-test-id='more-menu-button']`                 (aria "Show more options")
 *
 * `download-generated-image-button` is image-specific and only renders after
 * the image is ready, making it the cleanest single completion signal. The
 * image itself renders as `<img class="image loaded" alt=", AI generated">`
 * with a `blob:` object URL — which we must fetch via in-page JS since blob
 * URLs are scoped to the browser context.
 *
 * Refusal / policy-block detection: when the stream settles (no spinner,
 * sealed model-response) but the last `<model-response>` has no
 * `download-generated-image-button`, that is a refusal — the app rendered a
 * text-only reply to an image request. We also keep the narrow banner-text
 * check for Gemini's policy banners ("image generation request denied",
 * "due to interests of third-party content providers") since that wording
 * comes from Gemini's tool chrome, not from the model.
 */
class GeminiToolAdapter extends GenericImageToolAdapter {
  protected override async configureMode(page: Page): Promise<void> {
    // Gemini auto-routes image prompts when the prompt asks for an image;
    // the legacy "Create image" toggle is no longer required for standard
    // image generation. We keep a short opportunistic click in case a
    // Create Image affordance is present, but we don't fail without it.
    const createImageSelector = await waitForAnySelector(page, [
      "button:has-text('Create image')",
      "a:has-text('Create image')",
      "[aria-label*='Create image']",
    ], 3_000);

    if (createImageSelector) {
      console.error("[Gemini] configureMode: clicking Create image button");
      await page.locator(createImageSelector).first().click().catch(() => undefined);
      await delay(1_500);
    } else {
      console.error("[Gemini] configureMode: Create image toggle not present, proceeding");
    }
  }

  protected override async hasCompletionAffordance(page: Page): Promise<boolean> {
    const signals = await page.evaluate(() => {
      const responses = document.querySelectorAll("model-response");
      const lastResponse = responses[responses.length - 1];
      if (!lastResponse) {
        return { ready: false, reason: "no model-response yet" };
      }

      const downloadBtn = lastResponse.querySelector("[data-test-id='download-generated-image-button']");
      if (!downloadBtn) {
        return { ready: false, reason: "download-generated-image-button not rendered" };
      }

      const rect = (downloadBtn as HTMLElement).getBoundingClientRect();
      if (rect.width === 0 || rect.height === 0) {
        return { ready: false, reason: "download button not yet visible" };
      }

      return {
        ready: true,
        reason: "last model-response has download-generated-image-button",
      };
    }).catch(() => ({ ready: false, reason: "evaluate failed" }));

    if (signals.ready) {
      console.error(`[Gemini] completion-affordance: ${signals.reason}`);
    }
    return signals.ready;
  }

  /**
   * Detect Gemini's policy-block state: either the policy banner text
   * (authored by Gemini's chrome, not the model) or a structural refusal
   * (sealed model-response with no image affordance and no active spinner).
   */
  private async detectRefusal(page: Page): Promise<boolean> {
    const bodyText = (await page.locator("body").textContent().catch(() => "") ?? "").toLowerCase();
    if (
      this.isNewText(bodyText, "image generation request denied")
      || this.isNewText(bodyText, "due to interests of third-party content providers")
      || this.isNewText(bodyText, "please edit your prompt and try again")
    ) {
      return true;
    }

    return page.evaluate(() => {
      const spinners = Array.from(document.querySelectorAll("mat-progress-spinner, mat-spinner, mat-progress-bar"))
        .filter((element) => {
          const rect = (element as HTMLElement).getBoundingClientRect();
          return rect.width > 0 && rect.height > 0;
        });
      if (spinners.length > 0) return false;

      const responses = document.querySelectorAll("model-response");
      const lastResponse = responses[responses.length - 1];
      if (!lastResponse) return false;

      // If the image affordance is present, this is success, not refusal.
      if (lastResponse.querySelector("[data-test-id='download-generated-image-button']")) {
        return false;
      }

      // A sealed model-response with non-trivial text and no image chrome
      // = Gemini rendered a text-only reply to an image request.
      const text = (lastResponse.textContent ?? "").replace(/\s+/g, " ").trim();
      return text.length > 40 && !text.toLowerCase().startsWith("creating your image");
    }).catch(() => false);
  }

  protected override async waitForResultElements(page: Page, timeoutMs = 180_000): Promise<void> {
    await this.waitForCompletionAffordance(page, timeoutMs, async (p) => {
      if (await this.detectRefusal(p)) {
        throw new ToolGenerationBlockedError(
          "Image could not be produced due to a copyright or policy block from Gemini.",
          "copyright_block",
        );
      }
    });
  }

  protected override async captureResultElements(page: Page, outputDir: string): Promise<string[]> {
    const fileBase = path.join(outputDir, "gemini-result-1");

    // Preferred path: click Gemini's own download button and catch the file.
    // `hasCompletionAffordance` only returns true when this button is
    // rendered on the last `<model-response>`, so by the time we get here
    // the button is present — clicking it is more reliable than scraping
    // the `<img>` element, whose DOM structure has drifted over time.
    const downloaded = await this.downloadViaDownloadButton(page, fileBase);
    if (downloaded) {
      console.error(`[Gemini] result-saved: Downloaded image via download button ${downloaded}`);
      return [downloaded];
    }

    // Fallback: fetch the image's blob/data URL from the page context.
    const target = await this.findLastResponseImage(page);
    if (target) {
      const saved = await this.downloadImageAsBlob(target, fileBase);
      if (saved) {
        console.error(`[Gemini] result-saved: Downloaded image artifact ${saved}`);
        return [saved];
      }

      const screenshotPath = `${fileBase}.png`;
      await target.screenshot({ path: screenshotPath }).catch(() => undefined);
      try {
        await fs.access(screenshotPath);
        console.error(`[Gemini] result-saved: Screenshot fallback ${screenshotPath}`);
        return [screenshotPath];
      } catch {
        // fall through to generic capture
      }
    }

    console.error("[Gemini] result-capture-fallback: no primary capture path succeeded, using generic capture");
    return super.captureResultElements(page, outputDir);
  }

  /**
   * Click Gemini's in-chrome download button on the last `<model-response>`
   * and capture the resulting browser download event. This is the same
   * affordance we key off in `hasCompletionAffordance`, so when that check
   * gates entry into capture, the button is guaranteed to be there.
   */
  private async downloadViaDownloadButton(page: Page, fileBase: string): Promise<string | undefined> {
    const responses = page.locator("model-response");
    const count = await responses.count().catch(() => 0);
    if (count === 0) return undefined;

    const lastResponse = responses.nth(count - 1);
    const button = lastResponse.locator("[data-test-id='download-generated-image-button']").first();
    if ((await button.count().catch(() => 0)) === 0) return undefined;
    if (!(await button.isVisible().catch(() => false))) return undefined;

    const downloadPromise: Promise<Download | undefined> = page
      .waitForEvent("download", { timeout: 15_000 })
      .catch(() => undefined);
    await button.click().catch(() => undefined);
    const download = await downloadPromise;
    if (!download) return undefined;

    const suggested = download.suggestedFilename();
    const extension = path.extname(suggested).replace(/^\./, "").toLowerCase() || "png";
    const filePath = `${fileBase}.${extension}`;
    await download.saveAs(filePath);
    return filePath;
  }

  private async findLastResponseImage(page: Page): Promise<Locator | undefined> {
    const responses = page.locator("model-response");
    const count = await responses.count().catch(() => 0);
    if (count === 0) {
      return undefined;
    }

    const lastResponse = responses.nth(count - 1);

    // Prefer the most specific selectors first, then broaden. Gemini's image
    // `alt` and class names have drifted over time; checking `blob:` / `data:`
    // srcs covers the current rendering where the decorative alt/class may
    // not match but the src is still the generated bytes.
    const selectors = [
      "img[alt*='AI generated' i]",
      "img.image.loaded",
      "img[src^='blob:']",
      "img[src^='data:']",
      "img",
    ];

    for (const selector of selectors) {
      const candidate = lastResponse.locator(selector).first();
      if ((await candidate.count().catch(() => 0)) === 0) continue;
      if (!(await candidate.isVisible().catch(() => false))) continue;
      const box = await candidate.boundingBox().catch(() => null);
      if (box && box.width >= 200 && box.height >= 200) {
        return candidate;
      }
    }

    return undefined;
  }

  /**
   * Gemini's generated images use `blob:` object URLs. We `fetch()` the blob
   * from the page context (the only context where the URL is resolvable) and
   * transfer it out via a data-URL round-trip.
   */
  private async downloadImageAsBlob(node: Locator, fileBase: string): Promise<string | undefined> {
    const payload = await node.evaluate(async (element) => {
      if (!(element instanceof HTMLImageElement)) {
        return null;
      }

      const src = element.currentSrc || element.src;
      if (!src) {
        return null;
      }

      try {
        const response = await fetch(src);
        if (!response.ok) {
          return null;
        }
        const blob = await response.blob();
        const dataUrl = await new Promise<string>((resolve, reject) => {
          const reader = new FileReader();
          reader.onload = () => resolve(String(reader.result ?? ""));
          reader.onerror = () => reject(reader.error ?? new Error("Could not read blob."));
          reader.readAsDataURL(blob);
        });

        return {
          src,
          mimeType: blob.type,
          dataUrl,
        };
      } catch {
        return null;
      }
    }).catch(() => null);

    if (!payload?.dataUrl?.startsWith("data:")) {
      return undefined;
    }

    const match = payload.dataUrl.match(/^data:([^;]+);base64,([\s\S]+)$/);
    if (!match) {
      return undefined;
    }

    const mimeType = (match[1] ?? "image/png").toLowerCase();
    const extension =
      mimeType.includes("png") ? "png"
        : mimeType.includes("jpeg") || mimeType.includes("jpg") ? "jpg"
          : mimeType.includes("webp") ? "webp"
            : mimeType.includes("gif") ? "gif"
              : "png";
    const filePath = `${fileBase}.${extension}`;
    await fs.writeFile(filePath, Buffer.from(match[2]!, "base64"));
    return filePath;
  }
}

export const geminiAdapter = new GeminiToolAdapter(
  imageToolConfigs.find((tool) => tool.id === "gemini")!,
);
