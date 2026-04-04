import type { BrowserContext, Page } from "playwright";
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

export type AuthOpenResult =
  | { status: "authenticated" }
  | { status: "awaiting_login"; loginUrl: string; message: string };

export class AuthService {
  /** Open contexts kept alive so the user can log in, keyed by profile/tool id. */
  private readonly openContexts = new Map<string, BrowserContext>();

  public constructor(private readonly browser = new BrowserService()) {}

  public async ensureAuthenticated(config: AuthConfig, interactive = true): Promise<void> {
    const profileId = "profileId" in config ? config.profileId : undefined;
    const { context, page } = await this.browser.launchPage(config.id, profileId);
    try {
      await page.goto(config.url, { waitUntil: "domcontentloaded" });
      const authenticated = await this.isAuthenticated(page, config);
      if (authenticated) {
        return;
      }

      if (!interactive) {
        throw new AuthRequiredError(this.checkpoint(config, "Authentication is required before continuing."));
      }

      console.error(`\n${config.name} is not logged in.`);
      console.error(`Open browser profile: ${config.id}`);
      console.error(`Please log in manually at ${config.url}.\n`);
      if (input.isTTY && output.isTTY) {
        await waitForConfirmation(`Finish logging in to ${config.name}.`);
      } else {
        console.error(`Waiting for ${config.name} login to complete in the opened browser window...`);
        await this.waitForLogin(page, config);
      }

      const verified = await this.isAuthenticated(page, config);
      if (!verified) {
        throw new AuthRequiredError(this.checkpoint(config, "Login was not detected after confirmation."));
      }
    } finally {
      await context.close().catch(() => undefined);
    }
  }

  public async verifyPending(toolId: ToolId): Promise<void> {
    if (toolId !== "linkedin") {
      throw new Error(`verifyPending currently supports LinkedIn directly, and image tools should be resumed through their adapters: ${toolId}`);
    }

    await this.ensureAuthenticated(linkedInConfig, false);
  }

  /**
   * Non-blocking auth check for the ensure_auth MCP tool.
   *
   * - If already authenticated: closes the browser and returns `{ status: "authenticated" }`.
   * - If not authenticated: leaves the browser window open (so the user can log in) and
   *   returns `{ status: "awaiting_login", ... }`.  Call this method again once the user
   *   has finished logging in; it will close the previous window and open a fresh check.
   */
  public async openAndCheckAuth(config: AuthConfig): Promise<AuthOpenResult> {
    const profileId = "profileId" in config ? config.profileId : undefined;
    const key = profileId ?? config.id;

    // Close any previously-left-open browser for this profile so we don't accumulate windows.
    const prev = this.openContexts.get(key);
    if (prev) {
      this.openContexts.delete(key);
      await prev.close().catch(() => undefined);
    }

    const { context, page } = await this.browser.launchPage(config.id, profileId);

    const authenticated = await this.isAuthenticated(page, config);
    if (authenticated) {
      await context.close().catch(() => undefined);
      return { status: "authenticated" };
    }

    // Not logged in — keep the browser open so the user can log in without reopening it.
    this.openContexts.set(key, context);
    console.error(`[auth] ${config.name} not authenticated — browser left open at ${config.url}`);
    return {
      status: "awaiting_login",
      loginUrl: config.url,
      message: `${config.name} browser is open. Log in, then call ensure_auth again to confirm.`,
    };
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

    const loggedOutMatch = await waitForAnySelector(page, config.loginIndicators.loggedOutSelectors, 8_000);
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

    if (
      normalizedUrl.includes("accounts.google.com")
      || normalizedUrl.includes("/signin")
      || normalizedUrl.includes("/servicelogin")
    ) {
      this.logGeminiAuth(`redirected to sign-in @ ${url}`);
      return false;
    }

    // Check for explicit logged-out indicators first (sign-in button visible)
    const loggedOutVisible = await this.firstVisibleSelector(page, config.loginIndicators.loggedOutSelectors);
    if (loggedOutVisible) {
      this.logGeminiAuth(`logged-out selector visible: ${loggedOutVisible} @ ${url}`);
      return false;
    }

    // The Google Account button is the only reliable logged-in indicator.
    // Generic selectors (nav, main, New chat) appear for anonymous users too.
    const loggedInMatch = await waitForAnySelector(page, config.loginIndicators.loggedInSelectors, 5_000);
    if (loggedInMatch) {
      this.logGeminiAuth(`authenticated via ${loggedInMatch} @ ${url}`);
      return true;
    }

    this.logGeminiAuth(`no Google Account indicator found @ ${url}`);
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
    console.error(`[Gemini auth] ${message}`);
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
      console.error(`[Grok auth] landed on auth route @ ${url}`);
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
      console.error(`[Grok auth] usable anonymous or signed-in shell via ${usable} @ ${url}`);
      return true;
    }

    const loggedOutVisible = await this.firstVisibleSelector(page, config.loginIndicators.loggedOutSelectors);
    if (loggedOutVisible) {
      console.error(`[Grok auth] logged-out controls visible without usable shell: ${loggedOutVisible} @ ${url}`);
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
      console.error(`[Flow auth] detected Google sign-in route @ ${url}`);
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
      console.error(`[Flow auth] authenticated via workspace selector ${visibleWorkspace} @ ${url}`);
      return true;
    }

    const launcherSelector = await this.firstVisibleSelector(page, [
      "button:has-text('Create with Flow')",
      "button:has(span:has-text('Create with Flow'))",
    ]);

    if (!launcherSelector) {
      const loggedOutVisible = await this.firstVisibleSelector(page, config.loginIndicators.loggedOutSelectors);
      if (loggedOutVisible) {
        console.error(`[Flow auth] logged-out selector visible: ${loggedOutVisible} @ ${url}`);
        return false;
      }

      return false;
    }

    console.error(`[Flow auth] probing launcher ${launcherSelector} @ ${url}`);
    await page.locator(launcherSelector).first().click().catch(() => undefined);
    await delay(4_000);

    const nextUrl = page.url();
    const normalizedNextUrl = nextUrl.toLowerCase();
    if (
      normalizedNextUrl.includes("accounts.google.com")
      || normalizedNextUrl.includes("/signin")
      || normalizedNextUrl.includes("/servicelogin")
    ) {
      console.error(`[Flow auth] launcher redirected to Google sign-in @ ${nextUrl}`);
      return false;
    }

    const visibleAfterLaunch = await this.firstVisibleSelector(page, workspaceSelectors);
    if (visibleAfterLaunch) {
      console.error(`[Flow auth] authenticated after launcher via ${visibleAfterLaunch} @ ${nextUrl}`);
      return true;
    }

    console.error(`[Flow auth] launcher did not reach a detectable workspace @ ${nextUrl}`);
    return false;
  }
}
