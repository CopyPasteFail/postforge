import fs from "node:fs/promises";
import path from "node:path";

import type { Locator, Page } from "playwright";

import { imageToolConfigs } from "../../config/tools.js";
import { AuthRequiredError, CaptchaRequiredError } from "../auth.js";
import { GenericImageToolAdapter } from "./base.js";

interface CopilotImageCandidate {
  index: number;
  width: number;
  height: number;
  naturalWidth: number;
  naturalHeight: number;
  src: string;
  blurred: boolean;
}

class CopilotToolAdapter extends GenericImageToolAdapter {
  protected override async fillPrompt(page: Page, promptText: string): Promise<void> {
    const compactPrompt = promptText
      .split(/\r?\n+/)
      .map((line) => line.trim())
      .filter(Boolean)
      .join(" ");

    const copilotPrompt = [
      "Generate the final image now.",
      "Do not ask follow-up questions or ask for clarification.",
      "If any visual detail is ambiguous, make the most reasonable assumption and proceed.",
      compactPrompt,
    ].join(" ");

    await super.fillPrompt(page, copilotPrompt);
  }

  private async checkCaptcha(page: Page): Promise<void> {
    const hasCaptcha = await page.evaluate(() => {
      // Check for Cloudflare Turnstile iframe or widget.
      const iframes = Array.from(document.querySelectorAll("iframe"));
      for (const iframe of iframes) {
        const src = (iframe.src || "").toLowerCase();
        if (src.includes("challenges.cloudflare.com") || src.includes("turnstile") || src.includes("captcha")) {
          return true;
        }
      }
      // Check for Turnstile container elements.
      if (document.querySelector("#cf-turnstile, [class*='turnstile'], [class*='cf-chl'], [id*='cf-chl']")) {
        return true;
      }
      // Check page text for generic CAPTCHA indicators. This phrasing IS
      // tool chrome (Cloudflare / Microsoft verification banner), not model
      // output, so text matching is acceptable here.
      const text = document.body?.textContent?.toLowerCase() ?? "";
      return text.includes("verify you are human")
        || text.includes("human verification")
        || text.includes("are you a human");
    }).catch(() => false);

    if (hasCaptcha) {
      throw new CaptchaRequiredError({
        toolId: this.config.id,
        toolName: this.config.name,
        url: page.url(),
        reason: "Copilot is showing a human verification challenge (CAPTCHA). Please complete it in the browser and retry.",
        requestedAt: new Date().toISOString(),
      });
    }
  }

  private async checkSignInModal(page: Page): Promise<void> {
    // These phrases are tool-chrome (Copilot's sign-in modal), not model
    // output, so text matching is appropriate.
    const bodyText = await page.locator("body").textContent().catch(() => "") ?? "";
    const normalized = bodyText.toLowerCase();
    if (
      normalized.includes("sign in to keep creating")
      || normalized.includes("sign in and try again")
      || normalized.includes("you've hit the")
      || normalized.includes("continue with microsoft")
    ) {
      throw new AuthRequiredError({
        toolId: this.config.id,
        toolName: this.config.name,
        url: this.config.url,
        reason: "Copilot interrupted with a sign-in modal. Please log in and retry.",
        requestedAt: new Date().toISOString(),
      });
    }
  }

  /**
   * Copilot renders its image-result chrome ONLY after the image URL is
   * finalized and the assistant turn is sealed:
   *   - An `[data-testid="ai-image-message"]` container wraps the result.
   *   - Inside it, `[data-testid="ai-image-download-button"]` and
   *     `[data-testid="ai-image-share-button"]` render once the image is
   *     available for download.
   *   - The composer swaps in a `[data-testid="stop-button"]` during
   *     streaming and removes it at seal.
   *
   * Verified live against copilot.microsoft.com on 2026-04-14. These
   * `data-testid` attributes are semantic test hooks and far more stable
   * than text, aria-labels, or visual cues like image blur. Notably the
   * old "non-blurred image = ready" heuristic was wrong: Copilot always
   * renders a decorative `blur-sm` backdrop copy of the image, so
   * filtering by CSS blur never worked the way it appeared to.
   *
   * Completion = download button exists and is visible AND no active
   * Stop button anywhere (which would indicate a NEW generation kicked
   * off after the last seal).
   */
  protected override async hasCompletionAffordance(page: Page): Promise<boolean> {
    const signals = await page.evaluate(() => {
      const isVisible = (element: Element | null): boolean => {
        if (!element) return false;
        const htmlElement = element as HTMLElement;
        const rect = htmlElement.getBoundingClientRect();
        const style = window.getComputedStyle(htmlElement);
        return rect.width > 0
          && rect.height > 0
          && style.display !== "none"
          && style.visibility !== "hidden"
          && style.opacity !== "0";
      };

      const imageContainer = document.querySelector("[data-testid='ai-image-message']");
      if (!imageContainer) {
        return { ready: false, reason: "no [data-testid='ai-image-message'] yet" };
      }

      const downloadBtn = imageContainer.querySelector("[data-testid='ai-image-download-button']");
      if (!downloadBtn || !isVisible(downloadBtn)) {
        return { ready: false, reason: "image download affordance not rendered" };
      }

      const stopBtn = document.querySelector("button[data-testid='stop-button']");
      if (stopBtn && isVisible(stopBtn)) {
        return { ready: false, reason: "stop-button is active" };
      }

      return {
        ready: true,
        reason: "ai-image-message + ai-image-download-button rendered, no stop-button",
      };
    }).catch(() => ({ ready: false, reason: "evaluate failed" }));

    if (signals.ready) {
      console.error(`[Copilot] completion-affordance: ${signals.reason}`);
    }
    return signals.ready;
  }

  protected override async waitForResultElements(page: Page, timeoutMs = 420_000): Promise<void> {
    // Delegate to the base-class hook loop. The preCheck runs sign-in
    // and CAPTCHA detection on every iteration, since those interrupt
    // generation and must be surfaced as structured errors rather than
    // silently waiting for an affordance that will never arrive.
    await this.waitForCompletionAffordance(page, timeoutMs, async (p) => {
      await this.checkSignInModal(p);
      await this.checkCaptcha(p);
    });
  }

  protected override async captureResultElements(page: Page, outputDir: string): Promise<string[]> {
    const images = await this.collectVisibleImages(page);
    const resolved = images.filter((image) => !image.blurred);
    if (resolved.length === 0) {
      return super.captureResultElements(page, outputDir);
    }

    const target = resolved.sort((left, right) => (right.width * right.height) - (left.width * left.height))[0]!;
    const locator = page.locator("img").nth(target.index);
    const downloaded = await this.downloadResolvedImageCandidate(locator, path.join(outputDir, "copilot-result-1"));
    if (downloaded) {
      console.error(`[Copilot] result-saved: Downloaded resolved image artifact ${downloaded}`);
      return [downloaded];
    }

    const screenshotPath = path.join(outputDir, "copilot-result-1.png");
    await locator.screenshot({ path: screenshotPath }).catch(() => undefined);
    return [screenshotPath];
  }

  private async collectVisibleImages(page: Page): Promise<CopilotImageCandidate[]> {
    return page.locator("img").evaluateAll((nodes) => {
      const isBlurred = (element: Element | null): boolean => {
        let current: Element | null = element;
        while (current) {
          const filter = window.getComputedStyle(current).filter || "";
          if (filter.includes("blur")) {
            return true;
          }
          current = current.parentElement;
        }
        return false;
      };

      return nodes.map((node, index) => {
        const img = node as HTMLImageElement;
        const rect = img.getBoundingClientRect();
        const style = window.getComputedStyle(img);
        const visible =
          style.display !== "none"
          && style.visibility !== "hidden"
          && style.opacity !== "0"
          && rect.width > 200
          && rect.height > 200;

        if (!visible) {
          return null;
        }

        return {
          index,
          width: rect.width,
          height: rect.height,
          naturalWidth: img.naturalWidth || 0,
          naturalHeight: img.naturalHeight || 0,
          src: img.currentSrc || img.src || "",
          blurred: isBlurred(img),
        };
      }).filter(Boolean) as CopilotImageCandidate[];
    }).catch(() => []);
  }

  private async downloadResolvedImageCandidate(node: Locator, fileBase: string): Promise<string | undefined> {
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
            : "png";
    const filePath = `${fileBase}.${extension}`;
    await fs.writeFile(filePath, Buffer.from(match[2]!, "base64"));
    return filePath;
  }
}

export const copilotAdapter = new CopilotToolAdapter(
  imageToolConfigs.find((tool) => tool.id === "copilot")!,
);
