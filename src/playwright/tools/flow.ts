import fs from "node:fs/promises";
import path from "node:path";

import type { Download, Locator, Page } from "playwright";

import { imageToolConfigs } from "../../config/tools.js";
import type { ImageAsset, ImageAssetVariant } from "../../pipeline/types.js";
import { pathExists, writeJson } from "../../storage/fs-utils.js";
import { delay, waitForAnySelector } from "../waits.js";
import { GenericImageToolAdapter, ToolGenerationBlockedError } from "./base.js";

const selectAllKey = (): string =>
  process.platform === "darwin" ? "Meta+A" : "Control+A";

type FlowDownloadKind = "original" | "2k";

interface FlowVisibleImage {
  index: number;
  src: string;
  naturalWidth: number;
  naturalHeight: number;
}

interface FlowVariantMetadata {
  toolId: "flow";
  toolName: "Flow";
  sourceProjectUrl: string;
  sourceDetailUrl: string;
  sourceImageUrl: string;
  width: number;
  height: number;
  downloadKind: FlowDownloadKind;
  tileOrder: number;
  suggestedFilename: string;
  savedFilename: string;
  downloadedAt: string;
}

const sanitizeFilename = (value: string): string => value.replace(/[<>:"/\\|?*\u0000-\u001f]+/g, "-").replace(/\s+/g, " ").trim();

class FlowToolAdapter extends GenericImageToolAdapter {
  private latestVariants: ImageAssetVariant[] = [];
  private baselineSources = new Set<string>();

  public override async generate(runId: string, promptText: string, outputDir: string, interactive = true): Promise<ImageAsset> {
    this.latestVariants = [];
    this.baselineSources = new Set<string>();
    const asset = await super.generate(runId, promptText, outputDir, interactive);
    asset.variants = this.latestVariants;
    asset.notes = asset.files.length >= 2
      ? `${this.config.name} completed with ${asset.files.length} downloaded original-size image artifact(s).`
      : asset.notes;
    return asset;
  }

  public async downloadFromProjectUrl(
    runId: string,
    projectUrl: string,
    outputDir: string,
    downloadKind: FlowDownloadKind = "original",
  ): Promise<ImageAsset> {
    await fs.mkdir(outputDir, { recursive: true });
    this.latestVariants = [];
    this.baselineSources = new Set<string>();

    const { context, page } = await this.launchToolPage();
    try {
      await page.goto(this.config.url, { waitUntil: "domcontentloaded" });
      const authenticated = await this.checkAuthenticated(page);
      if (!authenticated) {
        await context.close();
        await this.ensureAuthenticated(true);
        return this.downloadFromProjectUrl(runId, projectUrl, outputDir, downloadKind);
      }

      await page.goto(projectUrl, { waitUntil: "domcontentloaded" });
      await delay(5_000);

      const screenshotPath = path.join(outputDir, "flow-existing-project.png");
      await page.screenshot({ path: screenshotPath, fullPage: true }).catch(() => undefined);

      const files = await this.downloadGeneratedImages(page, outputDir, downloadKind);
      return {
        id: `${runId}:${this.config.id}`,
        toolId: this.config.id,
        toolName: this.config.name,
        status: files.length > 0 ? "generated" : "warning",
        files,
        variants: this.latestVariants,
        screenshotPath,
        notes: files.length > 0
          ? `${this.config.name} downloaded ${files.length} image artifact(s) from existing project ${projectUrl}.`
          : `${this.config.name} opened existing project ${projectUrl}, but no downloadable images were found.`,
      };
    } finally {
      await context.close().catch(() => undefined);
    }
  }

  protected override async configureMode(page: Page): Promise<void> {
    await this.dismissStartupModal(page);

    const newProjectSelector = await waitForAnySelector(page, [
      "button:has-text('New project')",
    ], 8_000);

    if (newProjectSelector) {
      console.error(`[Flow] launcher-found: Using ${newProjectSelector}`);
      await page.locator(newProjectSelector).first().click();
      console.error("[Flow] launcher-clicked: Clicked New project");
      await waitForAnySelector(page, this.config.promptSelectors, 20_000);
      await this.ensureGenerationSettings(page);
      await this.captureBaselineSources(page);
      return;
    }

    const createWithFlowSelector = await waitForAnySelector(page, [
      "button:has-text('Create with Flow')",
      "button:has(span:has-text('Create with Flow'))",
    ], 8_000);

    if (!createWithFlowSelector) {
      return;
    }

    console.error(`[Flow] launcher-found: Using ${createWithFlowSelector}`);
    await page.locator(createWithFlowSelector).first().click();
    console.error("[Flow] launcher-clicked: Clicked Create with Flow");
    await waitForAnySelector(page, this.config.promptSelectors, 20_000);
    await this.ensureGenerationSettings(page);
    await this.captureBaselineSources(page);
  }

  private async dismissStartupModal(page: Page): Promise<void> {
    const getStartedSelector = await waitForAnySelector(page, [
      "button:has-text('Get started')",
      "[role='dialog'] button:has-text('Get started')",
      "text=Get started",
    ], 5_000).catch(() => undefined);

    if (!getStartedSelector) {
      return;
    }

    console.error(`[Flow] modal-found: Dismissing startup modal with ${getStartedSelector}`);
    const button = page.locator(getStartedSelector).last();
    await button.scrollIntoViewIfNeeded().catch(() => undefined);
    await button.click().catch(() => undefined);
    await delay(1_000);
  }

  protected override async fillPrompt(page: Page, promptText: string): Promise<void> {
    const editor = page.locator("div[role='textbox'][contenteditable='true']").first();
    const visible = await editor.isVisible().catch(() => false);
    if (!visible) {
      return super.fillPrompt(page, promptText);
    }

    await editor.scrollIntoViewIfNeeded().catch(() => undefined);
    await editor.click().catch(() => undefined);
    await page.keyboard.press(selectAllKey()).catch(() => undefined);
    await page.keyboard.press("Backspace").catch(() => undefined);
    await page.keyboard.insertText(promptText).catch(() => undefined);
    await delay(500);

    const text = await editor.textContent().catch(() => "") ?? "";
    if (!text.includes(promptText.slice(0, Math.min(24, promptText.length)))) {
      throw new Error(`Could not fill the visible prompt box for ${this.config.name}.`);
    }

    console.error(`[Flow] prompt-inserted: Prompt inserted into Flow textbox via keyboard input`);
  }

  protected override async waitForResultElements(page: Page, timeoutMs = 180_000): Promise<void> {
    const deadline = Date.now() + timeoutMs;
    let lastSignature = "";
    let stableChecks = 0;

    while (Date.now() < deadline) {
      const bodyText = await page.locator("body").textContent().catch(() => "") ?? "";
      const normalized = bodyText.toLowerCase();
      if (
        normalized.includes("image generation request denied")
        || normalized.includes("due to interests of third-party content providers")
        || normalized.includes("please edit your prompt and try again")
        || normalized.includes("i can't generate the image you requested right now")
        || normalized.includes("this generation might violate our policies")
        || normalized.includes("image generation failed")
        || normalized.includes("generation failed")
        || normalized.includes("try a different prompt or send feedback")
      ) {
        throw new ToolGenerationBlockedError(
          "Image could not be produced due to a copyright or policy block from Flow.",
          normalized.includes("third-party content") ? "copyright_block" : "policy_block",
        );
      }

      const images = this.selectTargetImages(await this.collectVisibleGeneratedImages(page));
      if (images.length >= 2) {
        const signature = images
          .slice(0, 2)
          .map((image) => `${image.index}:${image.naturalWidth}x${image.naturalHeight}:${image.src}`)
          .join("|");

        stableChecks = signature === lastSignature ? stableChecks + 1 : 1;
        lastSignature = signature;
        if (stableChecks >= 2) {
          console.error(`[Flow] result-ready: Detected ${images.length} stable generated image(s)`);
          return;
        }
      }

      await delay(1_500);
    }

    console.error(`[Flow] result-ready-timeout: Did not detect two stable generated images within ${Math.round(timeoutMs / 1_000)}s`);
  }

  protected override async captureResultElements(page: Page, outputDir: string): Promise<string[]> {
    const downloads = await this.downloadGeneratedImages(page, outputDir, "original");
    if (downloads.length > 0) {
      return downloads;
    }

    return super.captureResultElements(page, outputDir);
  }

  private async ensureGenerationSettings(page: Page): Promise<void> {
    const selectionText = await this.readSelectionSummary(page);
    if (selectionText.includes("nano banana 2") && selectionText.includes("x2")) {
      console.error(`[Flow] settings-ready: Using remembered settings "${selectionText}"`);
      return;
    }

    const trigger = await this.findSettingsTrigger(page);
    if (!trigger) {
      console.error("[Flow] settings-skip: Could not find settings trigger; using current Flow defaults");
      return;
    }

    await trigger.click().catch(() => undefined);
    await delay(750);

    await this.clickIfVisible(page, [
      "button:has-text('Image')",
      "[role='tab']:has-text('Image')",
      "text=Image",
    ]);

    await this.clickIfVisible(page, [
      "text=Nano Banana 2",
      "button:has-text('Nano Banana 2')",
      "[role='option']:has-text('Nano Banana 2')",
    ]);

    await this.clickIfVisible(page, [
      "button:has-text('x2')",
      "[role='tab']:has-text('x2')",
      "[role='option']:has-text('x2')",
      "text=x2",
    ]);

    await page.keyboard.press("Escape").catch(() => undefined);
    await delay(300);

    const updatedSummary = await this.readSelectionSummary(page);
    console.error(`[Flow] settings-ready: Flow selection summary is "${updatedSummary || "unknown"}"`);
  }

  private async readSelectionSummary(page: Page): Promise<string> {
    const candidates = [
      "button:has-text('Nano Banana')",
      "div:has-text('Nano Banana 2'):has-text('x2')",
      "text=Nano Banana 2",
    ];

    for (const selector of candidates) {
      const locator = page.locator(selector).first();
      const visible = await locator.isVisible().catch(() => false);
      if (!visible) {
        continue;
      }

      const text = await locator.textContent().catch(() => "") ?? "";
      const normalized = text.replace(/\s+/g, " ").trim().toLowerCase();
      if (normalized) {
        return normalized;
      }
    }

    return "";
  }

  private async findSettingsTrigger(page: Page) {
    const candidates = [
      "button:has-text('Nano Banana 2')",
      "button:has-text('Nano Banana')",
      "button:has-text('x2')",
      "[role='button']:has-text('Nano Banana 2')",
      "[role='button']:has-text('x2')",
    ];

    for (const selector of candidates) {
      const locator = page.locator(selector).first();
      const visible = await locator.isVisible().catch(() => false);
      if (visible) {
        return locator;
      }
    }

    return undefined;
  }

  private async clickIfVisible(page: Page, selectors: string[]): Promise<boolean> {
    const selector = await waitForAnySelector(page, selectors, 2_000).catch(() => undefined);
    if (!selector) {
      return false;
    }

    const target = page.locator(selector).first();
    await target.click().catch(() => undefined);
    await delay(400);
    return true;
  }

  private async collectVisibleGeneratedImages(page: Page): Promise<FlowVisibleImage[]> {
    const images = await page.locator("img[alt='Generated image']").evaluateAll((nodes) => nodes.map((node, index) => {
      const img = node as HTMLImageElement;
      const rect = img.getBoundingClientRect();
      const style = window.getComputedStyle(img);
      const visible =
        style.visibility !== "hidden"
        && style.display !== "none"
        && style.opacity !== "0"
        && rect.width > 150
        && rect.height > 150;
      return {
        index,
        visible,
        src: img.currentSrc || img.src || "",
        naturalWidth: img.naturalWidth || 0,
        naturalHeight: img.naturalHeight || 0,
      };
    })).catch(() => []);

    return images
      .filter((image) => image.visible)
      .sort((left, right) => left.index - right.index);
  }

  private selectTargetImages(images: FlowVisibleImage[]): FlowVisibleImage[] {
    const deduped = new Map<string, FlowVisibleImage>();
    for (const image of images) {
      if (!image.src || this.baselineSources.has(image.src)) {
        continue;
      }

      if (!deduped.has(image.src)) {
        deduped.set(image.src, image);
      }
    }

    const selected = [...deduped.values()].sort((left, right) => left.index - right.index);
    return selected.length > 0 ? selected : images.slice(0, 2);
  }

  private async captureBaselineSources(page: Page): Promise<void> {
    const images = await this.collectVisibleGeneratedImages(page);
    this.baselineSources = new Set(images.map((image) => image.src).filter(Boolean));
  }

  private async downloadGeneratedImages(page: Page, outputDir: string, downloadKind: FlowDownloadKind): Promise<string[]> {
    const savedFiles: string[] = [];
    const projectUrl = page.url();
    const images = this.selectTargetImages(await this.collectVisibleGeneratedImages(page));

    for (const image of images.slice(0, 2)) {
      await page.goto(projectUrl, { waitUntil: "domcontentloaded" }).catch(() => undefined);
      await delay(2_000);

      const tile = await this.findTileForImage(page, image);
      if (!tile) {
        console.error(`[Flow] result-skip: Could not re-locate tile ${image.index + 1} for src ${image.src}`);
        continue;
      }

      const visible = await tile.isVisible().catch(() => false);
      if (!visible) {
        continue;
      }

      await tile.scrollIntoViewIfNeeded().catch(() => undefined);
      await tile.click().catch(() => undefined);
      await delay(1_500);

      const variant = await this.downloadCurrentDetailImage(page, outputDir, savedFiles.length + 1, downloadKind, projectUrl, image);
      if (variant) {
        savedFiles.push(variant.filePath);
        this.latestVariants.push(variant.assetVariant);
        console.error(`[Flow] result-saved: Downloaded ${downloadKind} artifact ${variant.filePath}`);
      }
    }

    return savedFiles;
  }

  private async findTileForImage(page: Page, target: FlowVisibleImage): Promise<Locator | undefined> {
    const deadline = Date.now() + 12_000;

    while (Date.now() < deadline) {
      const currentImages = await this.collectVisibleGeneratedImages(page);
      const srcMatch = currentImages.find((image) => image.src && target.src && image.src === target.src);
      if (srcMatch) {
        return page.locator("img[alt='Generated image']").nth(srcMatch.index);
      }

      const byIndex = page.locator("img[alt='Generated image']").nth(target.index);
      const byIndexVisible = await byIndex.isVisible().catch(() => false);
      if (byIndexVisible) {
        return byIndex;
      }

      const fallbackIndex = Math.max(0, Math.min(target.index, currentImages.length - 1));
      if (currentImages[fallbackIndex]) {
        return page.locator("img[alt='Generated image']").nth(currentImages[fallbackIndex].index);
      }

      await delay(750);
    }

    return undefined;
  }

  private async downloadCurrentDetailImage(
    page: Page,
    outputDir: string,
    index: number,
    downloadKind: FlowDownloadKind,
    projectUrl: string,
    image: FlowVisibleImage,
  ): Promise<{ filePath: string; assetVariant: ImageAssetVariant } | undefined> {
    const trigger = page.locator("button").filter({ hasText: /^downloadDownload$/ }).first();
    const triggerVisible = await trigger.isVisible().catch(() => false);
    if (!triggerVisible) {
      return undefined;
    }

    await trigger.click().catch(() => undefined);
    await delay(750);

    const optionLabel = downloadKind === "2k" ? /Upscaled/ : /Original size/;
    const option = page.locator("[role='menuitem']").filter({ hasText: optionLabel }).first();
    const optionVisible = await option.isVisible().catch(() => false);
    if (!optionVisible) {
      await page.keyboard.press("Escape").catch(() => undefined);
      return undefined;
    }

    const download = await this.clickAndWaitForDownload(page, option);
    if (!download) {
      return undefined;
    }

    const suggested = download.suggestedFilename();
    const filePath = await this.buildOutputPath(outputDir, suggested, index);
    await download.saveAs(filePath);

    const metadataPath = await this.writeVariantMetadata({
      outputDir,
      filePath,
      projectUrl,
      detailUrl: page.url(),
      image,
      downloadKind,
      tileOrder: index,
      suggestedFilename: suggested,
    });

    return {
      filePath,
      assetVariant: {
        id: `${this.config.id}:tile-${index}`,
        label: `Flow Candidate ${index}`,
        filePath,
        metadataPath,
        sourceUrl: projectUrl,
        width: image.naturalWidth,
        height: image.naturalHeight,
        downloadKind: downloadKind === "2k" ? "2K Upscaled" : "Original size",
        tileOrder: index,
      },
    };
  }

  private async clickAndWaitForDownload(page: Page, target: Locator): Promise<Download | undefined> {
    const downloadPromise = page.waitForEvent("download", { timeout: 30_000 }).catch(() => undefined);
    await target.click().catch(() => undefined);
    return downloadPromise;
  }

  private async buildOutputPath(outputDir: string, suggestedFilename: string, tileOrder: number): Promise<string> {
    const parsed = path.parse(suggestedFilename);
    const safeBase = sanitizeFilename(parsed.name) || `flow-tile-${tileOrder}`;
    const extension = parsed.ext || ".jpg";
    let attempt = 0;

    while (attempt < 10) {
      const suffix = attempt === 0 ? "" : `-${attempt + 1}`;
      const candidate = path.join(outputDir, `${safeBase}-tile-${tileOrder}${suffix}${extension}`);
      if (!(await pathExists(candidate))) {
        return candidate;
      }
      attempt += 1;
    }

    return path.join(outputDir, `${safeBase}-tile-${tileOrder}-${Date.now()}${extension}`);
  }

  private async writeVariantMetadata(input: {
    outputDir: string;
    filePath: string;
    projectUrl: string;
    detailUrl: string;
    image: FlowVisibleImage;
    downloadKind: FlowDownloadKind;
    tileOrder: number;
    suggestedFilename: string;
  }): Promise<string> {
    const metadataPath = path.join(
      input.outputDir,
      `${path.parse(path.basename(input.filePath)).name}.metadata.json`,
    );

    const metadata: FlowVariantMetadata = {
      toolId: "flow",
      toolName: "Flow",
      sourceProjectUrl: input.projectUrl,
      sourceDetailUrl: input.detailUrl,
      sourceImageUrl: input.image.src,
      width: input.image.naturalWidth,
      height: input.image.naturalHeight,
      downloadKind: input.downloadKind,
      tileOrder: input.tileOrder,
      suggestedFilename: input.suggestedFilename,
      savedFilename: path.basename(input.filePath),
      downloadedAt: new Date().toISOString(),
    };

    await writeJson(metadataPath, metadata);
    return metadataPath;
  }
}

export const flowAdapter = new FlowToolAdapter(
  imageToolConfigs.find((tool) => tool.id === "flow")!,
);
