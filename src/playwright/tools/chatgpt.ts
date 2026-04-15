import fs from "node:fs/promises";
import path from "node:path";

import type { Locator, Page } from "playwright";

import { imageToolConfigs } from "../../config/tools.js";
import { GenericImageToolAdapter, ToolGenerationBlockedError } from "./base.js";

/**
 * ChatGPT image-generation chrome (verified live against chatgpt.com on
 * 2026-04-14).
 *
 * Each conversation message is wrapped in a `[data-testid^='conversation-turn']`
 * container. While an image is being generated, the page renders a
 * `[data-testid='image-gen-loading-state']` subtree inside the last turn and
 * streaming is gated by `button[data-testid='stop-button']` in the composer.
 *
 * Once the image is sealed, the loading state and stop button are gone and
 * the last turn picks up action buttons from the app's chrome:
 *   - `[data-testid='copy-turn-action-button']`      (assistant turn baseline)
 *   - `[data-testid='good-image-turn-action-button']`(image-specific thumbs-up)
 *   - `[data-testid='bad-image-turn-action-button']` (image-specific thumbs-down)
 *
 * The `*-image-turn-action-button` test-ids only render on assistant turns
 * that contain a sealed image result, so checking both of them (scoped to the
 * LATEST turn) is a reliable completion signal that doesn't depend on model-
 * authored text — which the user explicitly flagged as unreliable.
 *
 * Refusal / policy-block detection: the app's own decision to render text
 * instead of image chrome is itself a DOM signal. When the stream has settled
 * (no loading state, no stop-button) and the last turn is a sealed assistant
 * turn with text but no image chrome, that is a refusal — we surface it as a
 * ToolGenerationBlockedError so the pipeline can mark the result instead of
 * silently timing out. This reads DOM structure rendered by the app, not the
 * model's wording.
 */
class ChatGptToolAdapter extends GenericImageToolAdapter {
  protected override async hasCompletionAffordance(page: Page): Promise<boolean> {
    const signals = await page.evaluate(() => {
      const turns = document.querySelectorAll("[data-testid^='conversation-turn']");
      const lastTurn = turns[turns.length - 1];
      if (!lastTurn) {
        return { ready: false, reason: "no conversation-turn elements yet" };
      }

      const goodBtn = lastTurn.querySelector("[data-testid='good-image-turn-action-button']");
      const badBtn = lastTurn.querySelector("[data-testid='bad-image-turn-action-button']");
      if (!goodBtn || !badBtn) {
        return { ready: false, reason: "image-turn action buttons not rendered yet" };
      }

      // Streaming / mid-generation gates: loading state and stop button.
      if (document.querySelector("[data-testid^='image-gen-loading-state']")) {
        return { ready: false, reason: "image-gen-loading-state still present" };
      }
      if (document.querySelector("button[data-testid='stop-button']")) {
        return { ready: false, reason: "stop-button is active" };
      }

      return {
        ready: true,
        reason: "last turn has good+bad-image-turn-action-button, no loading state, no stop-button",
      };
    }).catch(() => ({ ready: false, reason: "evaluate failed" }));

    if (signals.ready) {
      console.error(`[ChatGPT] completion-affordance: ${signals.reason}`);
    }
    return signals.ready;
  }

  /**
   * True when the stream has settled but the last assistant turn has no image
   * chrome — i.e., the app rendered text instead of an image result. This is
   * the refusal path (copyright / policy block / "can't help with that"). We
   * key off DOM structure rendered by the app, not the model's wording.
   */
  private async isRefusal(page: Page): Promise<boolean> {
    return page.evaluate(() => {
      if (document.querySelector("[data-testid^='image-gen-loading-state']")) return false;
      if (document.querySelector("button[data-testid='stop-button']")) return false;

      const turns = document.querySelectorAll("[data-testid^='conversation-turn']");
      const lastTurn = turns[turns.length - 1];
      if (!lastTurn) return false;

      // Sealed assistant turns get a copy button from the app's chrome.
      if (!lastTurn.querySelector("[data-testid='copy-turn-action-button']")) return false;

      // If image chrome is present we treat it as success, not refusal.
      if (lastTurn.querySelector("[data-testid='good-image-turn-action-button']")) return false;
      if (lastTurn.querySelector("[data-testid='bad-image-turn-action-button']")) return false;

      // Non-trivial text content in a sealed assistant turn without image
      // chrome = the app rendered a text reply instead of an image.
      const text = (lastTurn.textContent ?? "").trim();
      return text.length > 40;
    }).catch(() => false);
  }

  protected override async waitForResultElements(page: Page, timeoutMs = 180_000): Promise<void> {
    await this.waitForCompletionAffordance(page, timeoutMs, async (p) => {
      if (await this.isRefusal(p)) {
        throw new ToolGenerationBlockedError(
          "ChatGPT refused the image request (no image produced).",
          "copyright_block",
        );
      }
    });
  }

  protected override async captureResultElements(page: Page, outputDir: string): Promise<string[]> {
    const target = await this.findLastTurnImage(page);
    if (!target) {
      console.error("[ChatGPT] result-capture-fallback: no image found in last turn, using generic capture");
      return super.captureResultElements(page, outputDir);
    }

    const fileBase = path.join(outputDir, "chatgpt-result-1");
    const saved = await this.downloadImageAsBlob(target, fileBase);
    if (saved) {
      console.error(`[ChatGPT] result-saved: Downloaded image artifact ${saved}`);
      return [saved];
    }

    const screenshotPath = `${fileBase}.png`;
    await target.screenshot({ path: screenshotPath }).catch(() => undefined);
    try {
      await fs.access(screenshotPath);
      console.error(`[ChatGPT] result-saved: Screenshot fallback ${screenshotPath}`);
      return [screenshotPath];
    } catch {
      return super.captureResultElements(page, outputDir);
    }
  }

  /**
   * Locate the generated image inside the LATEST conversation turn. Using
   * `img[alt*='Generated image']` is the most specific hit (the alt is set by
   * ChatGPT's chrome for image results); we fall back to the first visible
   * `<img>` in the last turn if the alt pattern changes.
   */
  private async findLastTurnImage(page: Page): Promise<Locator | undefined> {
    const turnLocator = page.locator("[data-testid^='conversation-turn']");
    const turnCount = await turnLocator.count().catch(() => 0);
    if (turnCount === 0) {
      return undefined;
    }

    const lastTurn = turnLocator.nth(turnCount - 1);

    const altMatch = lastTurn.locator("img[alt*='Generated image' i]").first();
    if ((await altMatch.count().catch(() => 0)) > 0 && (await altMatch.isVisible().catch(() => false))) {
      const box = await altMatch.boundingBox().catch(() => null);
      if (box && box.width >= 200 && box.height >= 200) {
        return altMatch;
      }
    }

    const fallback = lastTurn.locator("img").first();
    if ((await fallback.count().catch(() => 0)) > 0 && (await fallback.isVisible().catch(() => false))) {
      const box = await fallback.boundingBox().catch(() => null);
      if (box && box.width >= 200 && box.height >= 200) {
        return fallback;
      }
    }

    return undefined;
  }

  /**
   * In-page `fetch()` inherits session cookies, which is what ChatGPT's
   * `backend-api/estuary/content` endpoint requires. We round-trip the
   * resulting blob through a FileReader → data-URL so it crosses the
   * evaluate boundary, then persist it to disk.
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
        const response = await fetch(src, { credentials: "include" });
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

export const chatgptAdapter = new ChatGptToolAdapter(
  imageToolConfigs.find((tool) => tool.id === "chatgpt")!,
);
