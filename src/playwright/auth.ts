import type { Page } from "playwright";
import { stdin as input, stdout as output } from "node:process";

import { linkedInConfig, type ImageToolConfig, type LinkedInConfig, type ToolId } from "../config/tools.js";
import type { AuthCheckpoint } from "../pipeline/types.js";
import { waitForConfirmation } from "../pipeline/manual.js";
import { BrowserService } from "./browser.js";
import { delay, waitForAnySelector } from "./waits.js";

type AuthConfig = ImageToolConfig | LinkedInConfig;

const hasVisibleSelector = async (page: Page, selector: string): Promise<boolean> => {
  const locator = page.locator(selector).first();
  return (await locator.count()) > 0 && (await locator.isVisible().catch(() => false));
};

export class AuthRequiredError extends Error {
  public readonly checkpoint: AuthCheckpoint;

  public constructor(checkpoint: AuthCheckpoint) {
    super(`${checkpoint.toolName} requires login.`);
    this.checkpoint = checkpoint;
  }
}

export class AuthService {
  public constructor(private readonly browser = new BrowserService()) {}

  public async ensureAuthenticated(config: AuthConfig, interactive = true): Promise<void> {
    const { context, page } = await this.browser.launchPage(config.id);
    try {
      await page.goto(config.url, { waitUntil: "domcontentloaded" });
      const authenticated = await this.isAuthenticated(page, config);
      if (authenticated) {
        return;
      }

      if (!interactive) {
        throw new AuthRequiredError(this.checkpoint(config, "Authentication is required before continuing."));
      }

      console.log(`\n${config.name} is not logged in.`);
      console.log(`Open browser profile: ${config.id}`);
      console.log(`Please log in manually at ${config.url}.\n`);
      if (input.isTTY && output.isTTY) {
        await waitForConfirmation(`Finish logging in to ${config.name}.`);
      } else {
        console.log(`Waiting for ${config.name} login to complete in the opened browser window...`);
        await this.waitForLogin(page, config);
      }

      const verified = await this.isAuthenticated(page, config);
      if (!verified) {
        throw new AuthRequiredError(this.checkpoint(config, "Login was not detected after confirmation."));
      }
    } finally {
      await context.close();
    }
  }

  public async verifyPending(toolId: ToolId): Promise<void> {
    if (toolId !== "linkedin") {
      throw new Error(`verifyPending currently supports LinkedIn directly, and image tools should be resumed through their adapters: ${toolId}`);
    }

    await this.ensureAuthenticated(linkedInConfig, false);
  }

  public async isAuthenticated(page: Page, config: AuthConfig): Promise<boolean> {
    if (config.id === "gemini") {
      return this.isGeminiAuthenticated(page, config);
    }

    if (config.id === "flow") {
      return this.isFlowAuthenticated(page, config);
    }

    if (config.id === "grok") {
      return this.isGrokAvailable(page, config);
    }

    const loggedOutMatch = await waitForAnySelector(page, config.loginIndicators.loggedOutSelectors, 3_000);
    if (loggedOutMatch) {
      return false;
    }

    const loggedInMatch = await waitForAnySelector(page, config.loginIndicators.loggedInSelectors, 8_000);
    return Boolean(loggedInMatch);
  }

  private checkpoint(config: AuthConfig, reason: string): AuthCheckpoint {
    return {
      toolId: config.id,
      toolName: config.name,
      url: config.url,
      reason,
      requestedAt: new Date().toISOString(),
    };
  }

  private async waitForLogin(page: Page, config: AuthConfig, timeoutMs = 10 * 60_000): Promise<void> {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      if (await this.isAuthenticated(page, config)) {
        return;
      }

      await delay(1_000);
    }

    throw new AuthRequiredError(this.checkpoint(config, `Login was not detected within ${Math.round(timeoutMs / 60_000)} minutes.`));
  }

  private async isGeminiAuthenticated(page: Page, config: AuthConfig): Promise<boolean> {
    await page.waitForLoadState("domcontentloaded").catch(() => undefined);
    await delay(2_000);

    const url = page.url();
    const normalizedUrl = url.toLowerCase();
    const appRoute = normalizedUrl.includes("gemini.google.com/app");

    if (
      normalizedUrl.includes("accounts.google.com")
      || normalizedUrl.includes("/signin")
      || normalizedUrl.includes("/servicelogin")
    ) {
      return false;
    }

    const shellSelectors = [
      "div.ql-editor[contenteditable='true'][role='textbox'][aria-label*='Gemini']",
      "div[contenteditable='true'][role='textbox'][aria-label*='Enter a prompt for Gemini']",
      "div[contenteditable='true'][role='textbox'][data-placeholder*='Ask Gemini']",
      "div[contenteditable='true'][data-placeholder*='Ask Gemini']",
      "button:has-text('Create image')",
      "button:has-text('Create music')",
      "button:has-text('Write anything')",
      "button:has-text('Help me learn')",
      "button:has-text('Boost my day')",
      "button[aria-label*='Open side panel']",
      "button[aria-label*='New chat']",
      "nav",
      "main",
    ];

    const visibleShell = await this.firstVisibleSelector(page, shellSelectors);
    const visibleLoggedIn = await this.firstVisibleSelector(page, config.loginIndicators.loggedInSelectors);

    if (appRoute && (visibleShell || visibleLoggedIn)) {
      this.logGeminiAuth(`authenticated via app shell @ ${url}; shell=${visibleShell ?? "none"} loggedIn=${visibleLoggedIn ?? "none"}`);
      return true;
    }

    const loggedOutVisible = await this.firstVisibleSelector(page, config.loginIndicators.loggedOutSelectors);
    if (loggedOutVisible) {
      this.logGeminiAuth(`logged-out selector visible without app shell: ${loggedOutVisible} @ ${url}`);
      return false;
    }

    for (const selector of config.loginIndicators.loggedOutSelectors) {
      if (await hasVisibleSelector(page, selector)) {
        return false;
      }
    }

    const loggedInMatch = await waitForAnySelector(page, config.loginIndicators.loggedInSelectors, 5_000);
    if (loggedInMatch) {
      this.logGeminiAuth(`authenticated via logged-in selector ${loggedInMatch} @ ${url}`);
      return true;
    }

    this.logGeminiAuth(`no authenticated Gemini shell detected @ ${url}`);
    return false;
  }

  private async firstVisibleSelector(page: Page, selectors: string[]): Promise<string | undefined> {
    for (const selector of selectors) {
      if (await hasVisibleSelector(page, selector)) {
        return selector;
      }
    }

    return undefined;
  }

  private logGeminiAuth(message: string): void {
    console.log(`[Gemini auth] ${message}`);
  }

  private async isGrokAvailable(page: Page, config: AuthConfig): Promise<boolean> {
    await page.waitForLoadState("domcontentloaded").catch(() => undefined);
    await delay(2_000);

    const url = page.url();
    const normalizedUrl = url.toLowerCase();
    if (
      normalizedUrl.includes("/sign-in")
      || normalizedUrl.includes("/sign-up")
    ) {
      console.log(`[Grok auth] landed on auth route @ ${url}`);
      return false;
    }

    const usableSelectors = [
      ...config.loginIndicators.loggedInSelectors,
      "button[aria-label='Download']",
      "button[aria-label='Regenerate']",
      "button[aria-label='Start thread']",
      "button[aria-label='Create share link']",
    ];

    const usable = await this.firstVisibleSelector(page, usableSelectors);
    if (usable) {
      console.log(`[Grok auth] usable anonymous or signed-in shell via ${usable} @ ${url}`);
      return true;
    }

    const loggedOutVisible = await this.firstVisibleSelector(page, config.loginIndicators.loggedOutSelectors);
    if (loggedOutVisible) {
      console.log(`[Grok auth] logged-out controls visible without usable shell: ${loggedOutVisible} @ ${url}`);
      return false;
    }

    return false;
  }

  private async isFlowAuthenticated(page: Page, config: AuthConfig): Promise<boolean> {
    await page.waitForLoadState("domcontentloaded").catch(() => undefined);
    await delay(2_000);

    const url = page.url();
    const normalizedUrl = url.toLowerCase();

    if (
      normalizedUrl.includes("accounts.google.com")
      || normalizedUrl.includes("/signin")
      || normalizedUrl.includes("/servicelogin")
    ) {
      console.log(`[Flow auth] detected Google sign-in route @ ${url}`);
      return false;
    }

    const workspaceSelectors = [
      ...config.loginIndicators.loggedInSelectors,
      "textarea:not(.g-recaptcha-response)",
      "button:has-text('Create')",
      "button:has-text('Refine')",
      "button:has-text('Compose')",
    ];

    const visibleWorkspace = await this.firstVisibleSelector(page, workspaceSelectors);
    if (visibleWorkspace) {
      console.log(`[Flow auth] authenticated via workspace selector ${visibleWorkspace} @ ${url}`);
      return true;
    }

    const launcherSelector = await this.firstVisibleSelector(page, [
      "button:has-text('Create with Flow')",
      "button:has(span:has-text('Create with Flow'))",
    ]);

    if (!launcherSelector) {
      const loggedOutVisible = await this.firstVisibleSelector(page, config.loginIndicators.loggedOutSelectors);
      if (loggedOutVisible) {
        console.log(`[Flow auth] logged-out selector visible: ${loggedOutVisible} @ ${url}`);
        return false;
      }

      return false;
    }

    console.log(`[Flow auth] probing launcher ${launcherSelector} @ ${url}`);
    await page.locator(launcherSelector).first().click().catch(() => undefined);
    await delay(4_000);

    const nextUrl = page.url();
    const normalizedNextUrl = nextUrl.toLowerCase();
    if (
      normalizedNextUrl.includes("accounts.google.com")
      || normalizedNextUrl.includes("/signin")
      || normalizedNextUrl.includes("/servicelogin")
    ) {
      console.log(`[Flow auth] launcher redirected to Google sign-in @ ${nextUrl}`);
      return false;
    }

    const visibleAfterLaunch = await this.firstVisibleSelector(page, workspaceSelectors);
    if (visibleAfterLaunch) {
      console.log(`[Flow auth] authenticated after launcher via ${visibleAfterLaunch} @ ${nextUrl}`);
      return true;
    }

    console.log(`[Flow auth] launcher did not reach a detectable workspace @ ${nextUrl}`);
    return false;
  }
}
