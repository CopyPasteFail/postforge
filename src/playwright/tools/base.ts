import fs from "node:fs/promises";
import path from "node:path";

import type { Locator, Page } from "playwright";
import { stdin as input, stdout as output } from "node:process";

import type { ImageToolConfig } from "../../config/tools.js";
import type { ImageAsset } from "../../pipeline/types.js";
import { waitForConfirmation } from "../../pipeline/manual.js";
import { delay, waitForAnySelector, waitForBusyToSettle } from "../waits.js";
import { BrowserService } from "../browser.js";
import { AuthRequiredError, CaptchaRequiredError, AuthService } from "../auth.js";

export interface ToolAdapter {
  readonly config: ImageToolConfig;
  ensureAuthenticated(interactive?: boolean): Promise<void>;
  generate(runId: string, promptText: string, outputDir: string, interactive?: boolean): Promise<ImageAsset>;
}

export class ToolGenerationBlockedError extends Error {
  public constructor(
    message: string,
    public readonly reason: "copyright_block" | "policy_block" | "blocked",
  ) {
    super(message);
  }
}

const sanitizeFileSegment = (value: string): string => value.replace(/[^a-z0-9-_]+/gi, "-").toLowerCase();

const selectAllKey = (): string =>
  process.platform === "darwin" ? "Meta+A" : "Control+A";

interface ResultCandidate {
  selector: string;
  index: number;
  tagName: string;
  width: number;
  height: number;
  naturalWidth: number | undefined;
  naturalHeight: number | undefined;
  src: string | undefined;
  score: number;
}

export class GenericImageToolAdapter implements ToolAdapter {
  /** Page body text captured right after prompt submission, before generation starts.
   *  Subclasses use `isNewText()` to avoid false-positive block detection from old conversations. */
  protected preSubmitBodyText = "";

  /** When true, the browser window is kept open after generate() exits (e.g. for CAPTCHA). */
  private _keepBrowserOpen = false;

  public constructor(
    public readonly config: ImageToolConfig,
    protected readonly browser = new BrowserService(),
    protected readonly auth = new AuthService(),
  ) {}

  /** Returns true if `phrase` appears in `currentBodyText` but was NOT in the pre-submit baseline. */
  protected isNewText(currentBodyText: string, phrase: string): boolean {
    return currentBodyText.includes(phrase) && !this.preSubmitBodyText.includes(phrase);
  }

  public async ensureAuthenticated(interactive = true): Promise<void> {
    await this.auth.ensureAuthenticated(this.config, interactive);
  }

  protected async launchToolPage(): Promise<{ context: import("playwright").BrowserContext; page: Page }> {
    return this.browser.launchPage(this.config.id, this.config.profileId);
  }

  protected async checkAuthenticated(page: Page): Promise<boolean> {
    return this.auth.isAuthenticated(page, this.config);
  }

  public async testPromptInsertion(promptText: string, keepOpen = true): Promise<void> {
    const context = await this.browser.launchPersistent(this.config.id, this.config.profileId);
    const page = await context.newPage();
    try {
      this.logStep("navigating", `Opening ${this.config.url}`);
      await page.goto(this.config.url, { waitUntil: "domcontentloaded" });
      await page.bringToFront().catch(() => undefined);

      const isLoggedIn = await this.auth.isAuthenticated(page, this.config);
      if (!isLoggedIn) {
        await context.close();
        await this.ensureAuthenticated(true);
        return this.testPromptInsertion(promptText, keepOpen);
      }

      this.logStep("authenticated", `Confirmed logged-in session at ${page.url()}`);
      this.logStep("configure-mode", "Applying tool-specific mode configuration if needed");
      await this.configureMode(page);
      await page.bringToFront().catch(() => undefined);
      this.logStep("editor-search", "Looking for a visible prompt editor");
      await this.fillPrompt(page, promptText);
      const debugPath = path.join(process.cwd(), "output", `${sanitizeFileSegment(this.config.id)}-prompt-test.png`);
      await page.screenshot({ path: debugPath, fullPage: true }).catch(() => undefined);
      this.logStep("review-screenshot", `Saved prompt test screenshot to ${debugPath}`);

      if (!keepOpen) {
        return;
      }

      this.logStep("review-ready", "Prompt is inserted and the browser will stay open for manual review");
      if (input.isTTY && output.isTTY) {
        await waitForConfirmation(`Review ${this.config.name} in the open browser window.`);
      } else {
        this.logStep("review-wait", "TTY unavailable; keeping the browser open until the process is interrupted");
        await new Promise<void>(() => undefined);
      }
    } finally {
      await context.close().catch(() => undefined);
    }
  }

  public async generate(runId: string, promptText: string, outputDir: string, interactive = true): Promise<ImageAsset> {
    await fs.mkdir(outputDir, { recursive: true });

    const { context, page } = await this.browser.launchPage(this.config.id, this.config.profileId);
    try {
      // launchPage() already navigates to the tool URL for a fresh page.
      // Only re-navigate if we ended up somewhere else (e.g. a cached page at a different URL).
      const currentUrl = page.url().trim().toLowerCase();
      const targetOrigin = new URL(this.config.url).origin.toLowerCase();
      const alreadyThere = currentUrl && currentUrl !== "about:blank" && currentUrl.startsWith(targetOrigin);
      if (!alreadyThere) {
        this.logStep("navigating", `Opening ${this.config.url}`);
        await page.goto(this.config.url, { waitUntil: "domcontentloaded" });
      } else {
        this.logStep("navigating", `Already at ${page.url()} — skipping redundant navigation`);
      }

      const isLoggedIn = await this.auth.isAuthenticated(page, this.config);
      if (!isLoggedIn) {
        if (!interactive) {
          throw new AuthRequiredError({
            toolId: this.config.id,
            toolName: this.config.name,
            url: this.config.url,
            reason: "Authentication is required before image generation.",
            requestedAt: new Date().toISOString(),
          });
        }

        // Keep the same window open — no close/reopen cycle.
        this.logStep("auth-required", `Not logged in to ${this.config.name}. Waiting for login in the open browser window.`);
        await this.auth.waitForLoginOnPage(page, this.config);
        await page.goto(this.config.url, { waitUntil: "domcontentloaded" });
      }

      this.logStep("authenticated", `Confirmed logged-in session at ${page.url()}`);
      this.logStep("configure-mode", "Applying tool-specific mode configuration if needed");
      await this.configureMode(page);
      this.logStep("editor-search", "Looking for a visible prompt editor");
      await this.fillPrompt(page, promptText);
      this.logStep("submit-search", "Looking for a submit control");
      await this.submit(page);
      this.preSubmitBodyText = (await page.locator("body").textContent().catch(() => "") ?? "").toLowerCase();
      this.logStep("waiting-for-result", "Waiting for busy indicators to settle");
      await waitForBusyToSettle(page, this.config.busySelectors, 90_000).catch(() => undefined);
      await this.waitForResultElements(page);

      const screenshotPath = path.join(outputDir, `${sanitizeFileSegment(this.config.id)}-page.png`);
      this.logStep("page-screenshot", `Saving page screenshot to ${screenshotPath}`);
      await page.screenshot({ path: screenshotPath, fullPage: true });

      this.logStep("result-capture", "Capturing generated result elements");
      const files = await this.captureResultElements(page, outputDir);
      this.logStep("result-capture-done", `Captured ${files.length} artifact(s)`);

      return {
        id: `${runId}:${this.config.id}`,
        toolId: this.config.id,
        toolName: this.config.name,
        status: files.length > 0 ? "generated" : "warning",
        files,
        screenshotPath,
        notes: files.length > 0
          ? `${this.config.name} completed with ${files.length} captured artifact(s).`
          : `${this.config.name} completed but no result elements were captured automatically. Review the page screenshot and tune selectors if needed.`,
      };
    } catch (error) {
      if (error instanceof CaptchaRequiredError) {
        this._keepBrowserOpen = true;
        this.logStep("captcha-keep-open", "CAPTCHA detected — browser stays open for user to complete it.");
      }
      throw error;
    } finally {
      if (!this._keepBrowserOpen) {
        await this.reviewPause();
        await context.close().catch(() => undefined);
      }
      this._keepBrowserOpen = false;
    }
  }

  private async reviewPause(): Promise<void> {
    const raw = process.env["IMAGE_TOOL_REVIEW_DELAY_MS"];
    const ms = raw ? Number.parseInt(raw, 10) : 0;
    if (!ms || Number.isNaN(ms)) {
      return;
    }

    this.logStep("review-pause", `Keeping browser open for ${ms}ms for review (IMAGE_TOOL_REVIEW_DELAY_MS=${ms})`);
    await delay(ms);
  }

  protected async configureMode(_page: Page): Promise<void> {
    // Some sites will need live selector tuning for model or mode switching.
  }

  protected async fillPrompt(page: Page, promptText: string): Promise<void> {
    const visibleSelector = await waitForAnySelector(page, this.config.promptSelectors, 20_000);
    if (!visibleSelector) {
      if (await this.tryCopilotHiddenTextarea(page, promptText)) {
        return;
      }
      throw new Error(`No prompt selector matched for ${this.config.name}.`);
    }

    this.logStep("editor-found", `Using prompt selector ${visibleSelector}`);

    for (const selector of this.config.promptSelectors) {
      const locator = page.locator(selector).first();
      const isVisible = (await locator.count()) > 0 && (await locator.isVisible().catch(() => false));
      if (!isVisible) {
        continue;
      }
      const count = await page.locator(selector).count().catch(() => 0);
      this.logStep("editor-candidates", `Selector ${selector} matched ${count} node(s)`);
    }

    const editor = await this.pickBestPromptLocator(page);
    if (!editor) {
      if (await this.tryCopilotHiddenTextarea(page, promptText)) {
        return;
      }
      throw new Error(`Could not find a visible, interactive prompt box for ${this.config.name}.`);
    }

    const meta = await editor.evaluate((node) => ({
      tagName: node.tagName.toLowerCase(),
      role: node.getAttribute("role") ?? "",
      isSlate: node.getAttribute("data-slate-editor") === "true",
      placeholder: node.getAttribute("placeholder") ?? "",
      ariaLabel: node.getAttribute("aria-label") ?? "",
      textPreview: (node.textContent ?? "").trim().slice(0, 80),
    })).catch(() => ({
      tagName: "",
      role: "",
      isSlate: false,
      placeholder: "",
      ariaLabel: "",
      textPreview: "",
    }));

    await editor.scrollIntoViewIfNeeded().catch(() => undefined);
    await editor.click().catch(() => undefined);
    this.logStep("editor-target", `Selected ${meta.tagName || "unknown"} role=${meta.role || "-"} placeholder=${meta.placeholder || "-"} aria=${meta.ariaLabel || "-"}`);

    if (meta.tagName === "textarea" || meta.tagName === "input") {
      await editor.fill(promptText).catch(() => undefined);
      const value = await editor.inputValue().catch(() => "");
      if (value.trim() === promptText.trim()) {
        this.logStep("prompt-inserted", `Prompt inserted into ${meta.tagName} via fill()`);
        return;
      }
    } else {
      if (meta.isSlate) {
        await page.keyboard.press(selectAllKey()).catch(() => undefined);
        await page.keyboard.press("Backspace").catch(() => undefined);
        await page.keyboard.insertText(promptText).catch(() => undefined);
        const text = await editor.evaluate((node) => (node.textContent ?? "").trim()).catch(() => "");
        if (text.includes(promptText.slice(0, Math.min(24, promptText.length)))) {
          this.logStep("prompt-inserted", "Prompt inserted via keyboard input for Slate editor");
          return;
        }
      }

      const inserted = await editor.evaluate((node, text) => {
        const element = node as HTMLElement;
        element.focus();
        element.textContent = text;
        element.dispatchEvent(new InputEvent("input", {
          bubbles: true,
          inputType: "insertText",
          data: text,
        }));
        element.dispatchEvent(new Event("change", { bubbles: true }));
        return (element.textContent ?? "").trim();
      }, promptText).catch(() => "");

      if (inserted === promptText.trim()) {
        this.logStep("prompt-inserted", "Prompt inserted via textContent + input/change events");
        return;
      }

      await page.keyboard.press(selectAllKey()).catch(() => undefined);
      await page.keyboard.press("Backspace").catch(() => undefined);
      await page.keyboard.insertText(promptText).catch(() => undefined);
      const text = await editor.evaluate((node) => (node.textContent ?? "").trim()).catch(() => "");
      if (text.includes(promptText.slice(0, Math.min(24, promptText.length)))) {
        this.logStep("prompt-inserted", "Prompt inserted via keyboard fallback");
        return;
      }
    }

    throw new Error(`Could not fill the visible prompt box for ${this.config.name}.`);
  }

  private async tryCopilotHiddenTextarea(page: Page, promptText: string): Promise<boolean> {
    if (this.config.id !== "copilot") {
      return false;
    }

    const textarea = page.locator("textarea[placeholder*='Message Copilot'], textarea").first();
    const count = await textarea.count().catch(() => 0);
    if (count === 0) {
      return false;
    }

    const inserted = await textarea.evaluate((node, text) => {
      const element = node as HTMLTextAreaElement;
      element.value = text;
      element.dispatchEvent(new InputEvent("input", {
        bubbles: true,
        inputType: "insertText",
        data: text,
      }));
      element.dispatchEvent(new Event("change", { bubbles: true }));
      return element.value;
    }, promptText).catch(() => "");

    if (inserted.trim() !== promptText.trim()) {
      return false;
    }

    this.logStep("prompt-inserted", "Prompt inserted into Copilot hidden textarea via direct value assignment");
    return true;
  }

  protected async submit(page: Page): Promise<void> {
    const submitSelector = await waitForAnySelector(page, this.config.submitSelectors, 5_000);
    if (submitSelector) {
      this.logStep("submit-found", `Using submit selector ${submitSelector}`);
      await page.locator(submitSelector).first().click();
      this.logStep("submit-clicked", `Clicked ${submitSelector}`);
      return;
    }

    this.logStep("submit-fallback", "No submit selector matched; pressing Enter");
    await page.keyboard.press("Enter");
    this.logStep("submit-clicked", "Pressed Enter to submit");
  }

  protected async captureResultElements(page: Page, outputDir: string): Promise<string[]> {
    const savedFiles: string[] = [];
    const candidates = await this.collectResultCandidates(page);
    this.logStep("result-candidate-count", `Found ${candidates.length} filtered candidate(s)`);

    for (const candidate of candidates.slice(0, 4)) {
      const node = page.locator(candidate.selector).nth(candidate.index);
      const fileBase = path.join(outputDir, `${sanitizeFileSegment(this.config.id)}-result-${savedFiles.length + 1}`);

      if (candidate.tagName === "img") {
        const downloaded = await this.downloadImageCandidate(node, fileBase);
        if (downloaded) {
          savedFiles.push(downloaded);
          this.logStep("result-saved", `Downloaded image artifact ${downloaded}`);
          continue;
        }
      }

      const screenshotPath = `${fileBase}.png`;
      await node.screenshot({ path: screenshotPath }).catch(() => undefined);
      try {
        await fs.access(screenshotPath);
        savedFiles.push(screenshotPath);
        this.logStep("result-saved", `Saved result screenshot ${screenshotPath}`);
      } catch {
        // Ignore screenshot misses and continue.
      }
    }

    return savedFiles;
  }

  protected async waitForResultElements(page: Page, timeoutMs = 120_000): Promise<void> {
    const deadline = Date.now() + timeoutMs;
    let lastSignature = "";
    let stableChecks = 0;

    while (Date.now() < deadline) {
      const candidates = await this.collectResultCandidates(page);
      if (candidates.length > 0) {
        const signature = candidates
          .slice(0, 3)
          .map((candidate) => `${candidate.tagName}:${candidate.src ?? ""}:${Math.round(candidate.width)}x${Math.round(candidate.height)}:${candidate.naturalWidth ?? 0}x${candidate.naturalHeight ?? 0}`)
          .join("|");

        stableChecks = signature === lastSignature ? stableChecks + 1 : 1;
        lastSignature = signature;
        if (stableChecks >= 2) {
          this.logStep("result-ready", `Detected ${candidates.length} stable result candidate(s)`);
          return;
        }
      }

      await delay(1_000);
    }

    this.logStep("result-ready-timeout", `No stable result candidates detected within ${Math.round(timeoutMs / 1_000)}s`);
  }

  private async collectResultCandidates(page: Page): Promise<ResultCandidate[]> {
    const candidates: ResultCandidate[] = [];

    for (const selector of this.config.resultImageSelectors) {
      const locator = page.locator(selector);
      const count = await locator.count();
      this.logStep("result-selector-scan", `Selector ${selector} matched ${count} node(s)`);

      for (let index = 0; index < Math.min(count, 8); index += 1) {
        const node = locator.nth(index);
        const candidate = await node.evaluate((element) => {
          const htmlElement = element as HTMLElement;
          const rect = htmlElement.getBoundingClientRect();
          const style = window.getComputedStyle(htmlElement);
          if (
            rect.width < 180
            || rect.height < 180
            || style.visibility === "hidden"
            || style.display === "none"
            || style.opacity === "0"
          ) {
            return null;
          }

          const tagName = element.tagName.toLowerCase();
          const image = element as HTMLImageElement;
          const naturalWidth = tagName === "img" ? image.naturalWidth : undefined;
          const naturalHeight = tagName === "img" ? image.naturalHeight : undefined;
          const src = tagName === "img" ? (image.currentSrc || image.src || undefined) : undefined;
          const score = Math.max(
            rect.width * rect.height,
            (naturalWidth ?? 0) * (naturalHeight ?? 0),
          );

          return {
            tagName,
            width: rect.width,
            height: rect.height,
            naturalWidth,
            naturalHeight,
            src,
            score,
          };
        }).catch(() => null);

        if (!candidate) {
          continue;
        }

        candidates.push({
          selector,
          index,
          ...candidate,
        });
      }
    }

    return candidates.sort((left, right) => right.score - left.score);
  }

  private async downloadImageCandidate(node: Locator, fileBase: string): Promise<string | undefined> {
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
      } catch (error) {
        try {
          const canvas = document.createElement("canvas");
          canvas.width = element.naturalWidth || element.width;
          canvas.height = element.naturalHeight || element.height;
          const context = canvas.getContext("2d");
          if (!context) {
            throw new Error("Canvas 2D context unavailable.");
          }

          context.drawImage(element, 0, 0, canvas.width, canvas.height);
          return {
            src,
            mimeType: "image/png",
            dataUrl: canvas.toDataURL("image/png"),
            recoveredFrom: String(error),
          };
        } catch (fallbackError) {
          return {
            src,
            error: String(fallbackError),
          };
        }
      }
    }).catch(() => null);

    if (!payload || !("dataUrl" in payload) || !payload.dataUrl || !payload.dataUrl.startsWith("data:")) {
      return undefined;
    }

    const dataUrl = payload.dataUrl;
    const match = dataUrl.match(/^data:([^;]+);base64,([\s\S]+)$/);
    if (!match) {
      return undefined;
    }

    const mimeType = match[1] ?? "image/png";
    const base64 = match[2];
    if (!base64) {
      return undefined;
    }
    const extension = this.extensionForMimeType(mimeType, payload.src);
    const filePath = `${fileBase}.${extension}`;
    await fs.writeFile(filePath, Buffer.from(base64, "base64"));
    return filePath;
  }

  private extensionForMimeType(mimeType: string, src: string): string {
    const normalized = mimeType.toLowerCase();
    if (normalized.includes("png")) {
      return "png";
    }

    if (normalized.includes("jpeg") || normalized.includes("jpg")) {
      return "jpg";
    }

    if (normalized.includes("webp")) {
      return "webp";
    }

    if (normalized.includes("gif")) {
      return "gif";
    }

    if (normalized.includes("avif")) {
      return "avif";
    }

    const urlExtensionMatch = src.match(/\.([a-z0-9]+)(?:[?#]|$)/i);
    return urlExtensionMatch?.[1]?.toLowerCase() ?? "png";
  }

  private logStep(step: string, detail: string): void {
    console.error(`[${this.config.name}] ${step}: ${detail}`);
  }

  private async pickBestPromptLocator(page: Page): Promise<Locator | undefined> {
    let best: { locator: Locator; score: number } | undefined;

    for (const selector of this.config.promptSelectors) {
      const locator = page.locator(selector);
      const count = await locator.count().catch(() => 0);
      for (let index = 0; index < count; index += 1) {
        const candidate = locator.nth(index);
        const score = await candidate.evaluate((node) => {
          const element = node as HTMLElement;
          const rect = element.getBoundingClientRect();
          const style = window.getComputedStyle(element);
          if (
            style.display === "none"
            || style.visibility === "hidden"
            || style.opacity === "0"
            || rect.width < 120
            || rect.height < 20
          ) {
            return -1;
          }

          const viewportHeight = window.innerHeight || document.documentElement.clientHeight || 0;
          const viewportWidth = window.innerWidth || document.documentElement.clientWidth || 0;
          const inViewport =
            rect.bottom > 0
            && rect.right > 0
            && rect.top < viewportHeight
            && rect.left < viewportWidth;

          const placeholder = (element.getAttribute("placeholder") ?? "").toLowerCase();
          const ariaLabel = (element.getAttribute("aria-label") ?? "").toLowerCase();
          const role = (element.getAttribute("role") ?? "").toLowerCase();
          const text = (element.textContent ?? "").toLowerCase();

          let score = rect.width * rect.height;
          if (inViewport) score += 500_000;
          if (placeholder.includes("prompt") || placeholder.includes("describe") || placeholder.includes("message")) score += 200_000;
          if (ariaLabel.includes("prompt") || ariaLabel.includes("describe") || ariaLabel.includes("message")) score += 200_000;
          if (role.includes("textbox")) score += 100_000;
          if (text.length === 0) score += 20_000;
          return score;
        }).catch(() => -1);

        if (score < 0) {
          continue;
        }

        if (!best || score > best.score) {
          best = { locator: candidate, score };
        }
      }
    }

    return best?.locator;
  }
}
