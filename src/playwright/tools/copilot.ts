import fs from "node:fs/promises";
import path from "node:path";

import type { Locator, Page } from "playwright";

import { imageToolConfigs } from "../../config/tools.js";
import type { ImageAsset } from "../../pipeline/types.js";
import { delay } from "../waits.js";
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

  protected override async waitForResultElements(page: Page, timeoutMs = 420_000): Promise<void> {
    const deadline = Date.now() + timeoutMs;
    let sawGenerationSignals = false;
    let stableResolvedChecks = 0;
    let lastResolvedSignature = "";

    while (Date.now() < deadline) {
      const images = await this.collectVisibleImages(page);
      const ready = images.filter((image) => !image.blurred);
      const generationSignals = await this.hasGenerationSignals(page, images);
      const bodyText = await page.locator("body").textContent().catch(() => "") ?? "";
      const explicitReady = /your illustration is ready now/i.test(bodyText);

      if (generationSignals) {
        sawGenerationSignals = true;
      } else if (explicitReady && sawGenerationSignals) {
        console.log("[Copilot] result-ready: Copilot reported that the illustration is ready");
        return;
      } else if (sawGenerationSignals && ready.length > 0) {
        const signature = ready
          .map((image) => `${image.index}:${image.src}:${image.naturalWidth}x${image.naturalHeight}`)
          .join("|");
        stableResolvedChecks = signature === lastResolvedSignature ? stableResolvedChecks + 1 : 1;
        lastResolvedSignature = signature;
        if (stableResolvedChecks >= 2) {
          console.log(`[Copilot] result-ready: Detected ${ready.length} resolved image candidate(s) after generation finished`);
          return;
        }
      }

      await delay(1_500);
    }

    console.log(`[Copilot] result-ready-timeout: Copilot did not produce a resolved image within ${Math.round(timeoutMs / 1_000)}s`);
  }

  private async hasGenerationSignals(page: Page, images: CopilotImageCandidate[]): Promise<boolean> {
    if (images.some((image) => image.blurred)) {
      return true;
    }

    const bodyText = await page.locator("body").textContent().catch(() => "") ?? "";
    if (/your illustration is ready now/i.test(bodyText)) {
      return false;
    }
    if (/setting up|creating|generating/i.test(bodyText)) {
      return true;
    }

    return page.locator("button[aria-label*='Stop'], button[title*='Stop'], button:has-text('Stop')").evaluateAll((nodes) => {
      return nodes.some((node) => {
        const element = node as HTMLElement;
        const rect = element.getBoundingClientRect();
        const style = window.getComputedStyle(element);
        return style.display !== "none"
          && style.visibility !== "hidden"
          && style.opacity !== "0"
          && rect.width > 10
          && rect.height > 10;
      });
    }).catch(() => false);
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
      console.log(`[Copilot] result-saved: Downloaded resolved image artifact ${downloaded}`);
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
