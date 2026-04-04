import type { Page } from "playwright";

import { linkedInConfig } from "../../config/tools.js";
import { BrowserService } from "../browser.js";
import { AuthRequiredError, AuthService } from "../auth.js";
import { delay, waitForAnySelector } from "../waits.js";

const selectAllKey = (): string =>
  process.platform === "darwin" ? "Meta+A" : "Control+A";

type LinkedInComposerState = "feed" | "compose" | "media-editor" | "final-composer";

export class LinkedInAdapter {
  public constructor(
    private readonly browser = new BrowserService(),
    private readonly auth = new AuthService(),
  ) {}

  public async ensureAuthenticated(interactive = true): Promise<void> {
    await this.auth.ensureAuthenticated(linkedInConfig, interactive);
  }

  public async prepareComposer(postText: string, imagePath: string, interactive = true): Promise<void> {
    const { context, page } = await this.browser.launchPage(linkedInConfig.id);
    try {
      await page.goto(linkedInConfig.composeUrl, { waitUntil: "domcontentloaded" });
      const isLoggedIn = await this.auth.isAuthenticated(page, linkedInConfig);
      if (!isLoggedIn) {
        if (interactive) {
          await context.close();
          await this.ensureAuthenticated(true);
          return this.prepareComposer(postText, imagePath, false);
        }

        throw new AuthRequiredError({
          toolId: linkedInConfig.id,
          toolName: linkedInConfig.name,
          url: linkedInConfig.url,
          reason: "Authentication is required before preparing LinkedIn.",
          requestedAt: new Date().toISOString(),
        });
      }

      await this.reachFinalComposer(page, imagePath);
      await this.fillText(page, postText);
      await this.saveDraft(page);
      console.log("\nLinkedIn draft saved.\n");
    } finally {
      await context.close();
    }
  }

  public async prepareTextOnly(postText: string, interactive = true): Promise<void> {
    const { context, page } = await this.browser.launchPage(linkedInConfig.id);
    try {
      await page.goto(linkedInConfig.composeUrl, { waitUntil: "domcontentloaded" });
      const isLoggedIn = await this.auth.isAuthenticated(page, linkedInConfig);
      if (!isLoggedIn) {
        if (interactive) {
          await context.close();
          await this.ensureAuthenticated(true);
          return this.prepareTextOnly(postText, false);
        }

        throw new AuthRequiredError({
          toolId: linkedInConfig.id,
          toolName: linkedInConfig.name,
          url: linkedInConfig.url,
          reason: "Authentication is required before preparing LinkedIn.",
          requestedAt: new Date().toISOString(),
        });
      }

      await this.reachTextComposer(page);
      await this.fillText(page, postText);
      await this.saveDraft(page);
      console.log("\nLinkedIn text draft saved.\n");
    } finally {
      await context.close();
    }
  }

  private async openComposer(page: Page): Promise<void> {
    await page.waitForLoadState("domcontentloaded").catch(() => undefined);
    await delay(3_000);

    for (let attempt = 0; attempt < 3; attempt += 1) {
      const startSelector = await waitForAnySelector(page, linkedInConfig.startPostSelectors, 10_000);
      if (!startSelector) {
        break;
      }

      const trigger = page.locator(startSelector).first();
      await trigger.scrollIntoViewIfNeeded().catch(() => undefined);
      await trigger.hover().catch(() => undefined);
      await trigger.click({ timeout: 5_000 }).catch(async () => {
        await trigger.click({ timeout: 5_000, force: true }).catch(async () => {
          const box = await trigger.boundingBox().catch(() => null);
          if (box) {
            await page.mouse.click(box.x + (box.width / 2), box.y + (box.height / 2)).catch(() => undefined);
          }
        });
      });
      if (await this.waitForComposerSurface(page, 10_000)) {
        return;
      }

      await trigger.focus().catch(() => undefined);
      await page.keyboard.press("Enter").catch(() => undefined);
      if (await this.waitForComposerSurface(page, 10_000)) {
        return;
      }

      await trigger.evaluate((element) => {
        (element as HTMLElement).click();
      }).catch(() => undefined);
      if (await this.waitForComposerSurface(page, 10_000)) {
        return;
      }

      await delay(1_500);
    }

    throw new Error("Could not open the LinkedIn composer from the feed page.");
  }

  private async reachFinalComposer(page: Page, imagePath: string): Promise<void> {
    for (let attempt = 0; attempt < 4; attempt += 1) {
      const state = await this.detectComposerState(page);
      if (state === "final-composer") {
        return;
      }

      if (state === "media-editor") {
        await this.advancePastMediaEditor(page);
        await delay(2_000);
        continue;
      }

      if (state === "compose") {
        await this.uploadImage(page, imagePath);
        await delay(2_000);
        continue;
      }

      await this.openComposer(page);
      await delay(2_000);
    }

    throw new Error("Could not reach the final LinkedIn composer state.");
  }

  private async reachTextComposer(page: Page): Promise<void> {
    for (let attempt = 0; attempt < 3; attempt += 1) {
      const state = await this.detectComposerState(page);
      if (state === "final-composer" || state === "compose") {
        return;
      }

      if (state === "media-editor") {
        await this.dismissDialog(page);
        await delay(2_000);
        continue;
      }

      await this.openComposer(page);
      await delay(2_000);
    }

    throw new Error("Could not reach the LinkedIn text composer.");
  }

  private async uploadImage(page: Page, imagePath: string): Promise<void> {
    if (await this.hasAttachedMedia(page)) {
      return;
    }

    const dialogUploadSelectors = linkedInConfig.uploadSelectors.map((selector) => `div[role='dialog'] ${selector}`);
    let inputSelector = await waitForAnySelector(page, dialogUploadSelectors, 15_000);
    if (!inputSelector) {
      inputSelector = await waitForAnySelector(page, linkedInConfig.uploadSelectors, 5_000);
    }

    if (!inputSelector) {
      const mediaButton = page.locator([
        "div[role='dialog'] button[aria-label*='Photo']",
        "div[role='dialog'] button[aria-label*='photo']",
        "div[role='dialog'] button[aria-label*='media']",
        "div[role='dialog'] button:right-of(:text('Rewrite with AI'))",
      ].join(", ")).first();

      if ((await mediaButton.count()) === 0 || !(await mediaButton.isVisible().catch(() => false))) {
        throw new Error("Could not find the LinkedIn media upload input.");
      }

      const chooserPromise = page.waitForEvent("filechooser", { timeout: 10_000 }).catch(() => undefined);
      await mediaButton.click({ timeout: 5_000 }).catch(() => undefined);
      const chooser = await chooserPromise;
      if (!chooser) {
        throw new Error("LinkedIn media button did not open a file chooser.");
      }

      await chooser.setFiles(imagePath);
      await this.waitForMediaAttachment(page);
      return;
    }

    await page.locator(inputSelector).first().setInputFiles(imagePath);
    await this.waitForMediaAttachment(page);
  }

  private async advancePastMediaEditor(page: Page): Promise<void> {
    for (let step = 0; step < 2; step += 1) {
      const textReady = await this.waitForComposerTextSelector(page, 8_000);
      if (textReady) {
        return;
      }

      const nextButton = page.locator("div[role='dialog'] button:has-text('Next'), button:has-text('Next')").last();
      const nextVisible = (await nextButton.count()) > 0 && (await nextButton.isVisible().catch(() => false));
      if (!nextVisible) {
        const state = await this.detectComposerState(page);
        if (state === "final-composer") {
          return;
        }

        throw new Error("LinkedIn media editor did not expose a visible Next button.");
      }

      await nextButton.click({ timeout: 5_000 }).catch(() => undefined);
      await delay(5_000);
    }
  }

  private async fillText(page: Page, postText: string): Promise<void> {
    const textSelector = await this.waitForComposerTextSelector(page, 30_000);
    if (!textSelector) {
      throw new Error("Could not find the LinkedIn composer text area.");
    }

    const locator = page.locator(textSelector).first();
    const tagName = await locator.evaluate((node) => node.tagName.toLowerCase());
    await locator.click();

    if (tagName === "textarea" || tagName === "input") {
      await locator.fill(postText);
      return;
    }

    await page.keyboard.press(selectAllKey()).catch(() => undefined);
    await page.keyboard.press("Backspace").catch(() => undefined);
    await page.keyboard.insertText(postText);
    await page.waitForTimeout(1_000).catch(() => undefined);
  }

  private async saveDraft(page: Page): Promise<void> {
    await this.closeComposer(page);

    const saveSelector = await waitForAnySelector(page, linkedInConfig.saveDraftSelectors, 10_000);
    if (!saveSelector) {
      throw new Error("LinkedIn did not offer a Save as draft action after closing the composer.");
    }

    await page.locator(saveSelector).first().click({ timeout: 5_000 }).catch(async () => {
      await page.locator(saveSelector).first().click({ timeout: 5_000, force: true }).catch(() => undefined);
    });

    await delay(2_000);
  }

  private async closeComposer(page: Page): Promise<void> {
    await page.keyboard.press("Escape").catch(() => undefined);
    await delay(500);

    if (await this.hasSaveDraftDialog(page)) {
      return;
    }

    const dismissSelector = await waitForAnySelector(page, linkedInConfig.dismissSelectors, 5_000);
    if (!dismissSelector) {
      throw new Error("Could not find the LinkedIn composer close button.");
    }

    const button = page.locator(dismissSelector).last();
    await button.click({ timeout: 5_000 }).catch(async () => {
      await button.click({ timeout: 5_000, force: true }).catch(async () => {
        const box = await button.boundingBox().catch(() => null);
        if (box) {
          await page.mouse.click(box.x + (box.width / 2), box.y + (box.height / 2)).catch(() => undefined);
        }
      });
    });

    await delay(1_500);
    if (await this.hasSaveDraftDialog(page)) {
      return;
    }

    await page.keyboard.press("Escape").catch(() => undefined);
    await delay(1_000);
  }

  private async hasSaveDraftDialog(page: Page): Promise<boolean> {
    if (await waitForAnySelector(page, linkedInConfig.saveDraftSelectors, 1_000)) {
      return true;
    }

    const bodyText = await page.locator("body").innerText().catch(() => "");
    return bodyText.includes("Save this post as a draft?");
  }

  private async waitForComposerSurface(page: Page, timeoutMs: number): Promise<boolean> {
    const dialogSelector = await waitForAnySelector(page, [
      "div[role='dialog']",
      "div[aria-label*='Create a post']",
      "div[aria-label*='post text editor']",
      "button:has-text('Post')",
    ], timeoutMs);

    return Boolean(dialogSelector);
  }

  private async hasAttachedMedia(page: Page): Promise<boolean> {
    if (await this.hasMediaPreview(page)) {
      return true;
    }

    const mediaEditorSelector = await waitForAnySelector(page, [
      "div[role='dialog']:has-text('Editor')",
      "div[role='dialog'] button:has-text('Next')",
      "div[role='dialog'] button[aria-label*='Next']",
    ], 1_000);

    return Boolean(mediaEditorSelector);
  }

  private async waitForMediaAttachment(page: Page): Promise<void> {
    const matched = await waitForAnySelector(page, [
      "div[role='dialog']:has-text('Editor')",
      "button:has-text('Next')",
      "button[aria-label*='Next']",
      "div[role='dialog'] img",
    ], 20_000);

    if (matched) {
      return;
    }

    const deadline = Date.now() + 20_000;
    while (Date.now() < deadline) {
      if (await this.hasMediaPreview(page)) {
        return;
      }

      await delay(500);
    }
  }

  private async waitForComposerTextSelector(page: Page, timeoutMs: number): Promise<string | undefined> {
    const dialogSelectors = linkedInConfig.textAreaSelectors.map((selector) => `div[role='dialog'] ${selector}`);
    const dialogMatch = await waitForAnySelector(page, dialogSelectors, timeoutMs);
    if (dialogMatch) {
      return dialogMatch;
    }

    return waitForAnySelector(page, linkedInConfig.textAreaSelectors, Math.min(timeoutMs, 5_000));
  }

  private async detectComposerState(page: Page): Promise<LinkedInComposerState> {
    const mediaEditorSelector = await waitForAnySelector(page, [
      "div[role='dialog']:has-text('Editor')",
      "div[role='dialog'] button:has-text('Next')",
      "div[role='dialog'] button[aria-label*='Next']",
    ], 1_000);
    if (mediaEditorSelector) {
      return "media-editor";
    }

    const finalTextSelector = await this.waitForComposerTextSelector(page, 1_000);
    if (finalTextSelector && await this.hasVisibleDialog(page)) {
      if (await this.hasMediaPreview(page)) {
        return "final-composer";
      }

      return "compose";
    }

    const dialogVisible = await this.hasVisibleDialog(page);
    if (dialogVisible) {
      return "compose";
    }

    return "feed";
  }

  private async hasVisibleDialog(page: Page): Promise<boolean> {
    const dialog = page.locator("div[role='dialog']").first();
    return (await dialog.count()) > 0 && (await dialog.isVisible().catch(() => false));
  }

  private async dismissDialog(page: Page): Promise<void> {
    const closeButton = page.locator([
      "div[role='dialog'] button[aria-label*='Dismiss']",
      "div[role='dialog'] button[aria-label*='Close']",
      "div[role='dialog'] button[aria-label*='discard']",
      "div[role='dialog'] button svg",
    ].join(", ")).first();

    if ((await closeButton.count()) > 0 && (await closeButton.isVisible().catch(() => false))) {
      await closeButton.click({ force: true }).catch(() => undefined);
      await delay(1_500);
      return;
    }

    await page.keyboard.press("Escape").catch(() => undefined);
    await delay(1_500);
  }

  private async hasMediaPreview(page: Page): Promise<boolean> {
    const dialog = page.locator("div[role='dialog']").first();
    if ((await dialog.count()) === 0 || !(await dialog.isVisible().catch(() => false))) {
      return false;
    }

    return dialog.evaluate((root) => {
      const images = Array.from(root.querySelectorAll("img"));
      return images.some((image) => {
        const element = image as HTMLImageElement;
        const rect = element.getBoundingClientRect();
        return rect.width >= 150 && rect.height >= 150;
      });
    }).catch(() => false);
  }
}
