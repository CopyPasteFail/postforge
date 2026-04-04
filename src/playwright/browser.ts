import { execSync } from "node:child_process";
import fs from "node:fs";

import { chromium, type BrowserContext, type Page } from "playwright";

import { toolProfilePath } from "../config/paths.js";
import { imageToolConfigs, linkedInConfig } from "../config/tools.js";

const headless = /^true$/i.test(process.env.PLAYWRIGHT_HEADLESS ?? "false");
const browserChannel = process.env.PLAYWRIGHT_CHANNEL ?? "chrome";
const windowWidth = Number(process.env.PLAYWRIGHT_WINDOW_WIDTH ?? "1280");
const windowHeight = Number(process.env.PLAYWRIGHT_WINDOW_HEIGHT ?? "820");
const deviceScaleFactor = Number(process.env.PLAYWRIGHT_DEVICE_SCALE_FACTOR ?? "0.9");

const toolUrlFor = (toolId: string): string | undefined => {
  const imageTool = imageToolConfigs.find((tool) => tool.id === toolId);
  if (imageTool) {
    return imageTool.url;
  }

  if (toolId === linkedInConfig.id) {
    return linkedInConfig.url;
  }

  return undefined;
};

const sameOrigin = (left: string, right: string): boolean => {
  try {
    return new URL(left).origin === new URL(right).origin;
  } catch {
    return false;
  }
};

export class BrowserService {
  public async launchPersistent(toolId: string, profileId?: string): Promise<BrowserContext> {
    const profilePath = toolProfilePath(profileId ?? toolId);
    try {
      return await this.doLaunch(profilePath);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      // Chrome found an existing session using this profile — kill it and retry.
      if (
        message.includes("Opening in existing browser session")
        || message.includes("Target page, context or browser has been closed")
        || message.includes("Failed to launch")
      ) {
        console.error(`[browser] Launch failed for ${profileId ?? toolId}: ${message.slice(0, 120)}`);
        console.error(`[browser] Killing stale Chrome processes for profile ${profilePath}`);
        this.killStaleChrome(profilePath);
        this.clearProfileLocks(profilePath);
        return this.doLaunch(profilePath);
      }
      throw error;
    }
  }

  private async doLaunch(profilePath: string): Promise<BrowserContext> {
    const context = await chromium.launchPersistentContext(profilePath, {
      channel: browserChannel,
      headless,
      acceptDownloads: true,
      viewport: null,
      ignoreDefaultArgs: [
        "--enable-automation",
      ],
      args: [
        `--window-size=${windowWidth},${windowHeight}`,
        `--force-device-scale-factor=${deviceScaleFactor}`,
        "--disable-blink-features=AutomationControlled",
        "--disable-infobars",
      ],
    });

    await context.addInitScript(() => {
      Object.defineProperty(navigator, "webdriver", {
        get: () => false,
      });
    });

    return context;
  }

  /**
   * Kill Chrome processes whose command line contains the given profile path.
   * Falls back to no-op if the platform command fails.
   */
  private killStaleChrome(profilePath: string): void {
    const normalized = profilePath.replace(/\//g, "\\");
    try {
      if (process.platform === "win32") {
        // WMIC lists Chrome PIDs whose command line contains the profile path.
        const output = execSync(
          `wmic process where "name='chrome.exe' and commandline like '%${normalized.replace(/\\/g, "\\\\")}%'" get processid`,
          { encoding: "utf8", timeout: 10_000 },
        ).trim();
        const pids = output.split(/\r?\n/).slice(1).map((line) => line.trim()).filter(Boolean);
        for (const pid of pids) {
          try {
            execSync(`taskkill /F /PID ${pid}`, { timeout: 5_000 });
            console.error(`[browser] Killed stale Chrome PID ${pid}`);
          } catch {
            // Process may have already exited.
          }
        }
      } else {
        execSync(
          `pkill -f "chrome.*${profilePath.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}" || true`,
          { timeout: 5_000 },
        );
      }
    } catch {
      console.error("[browser] Could not kill stale Chrome processes (non-fatal)");
    }
  }

  private clearProfileLocks(profilePath: string): void {
    for (const lockFile of ["SingletonLock", "SingletonSocket", "SingletonCookie"]) {
      try {
        fs.rmSync(`${profilePath}/${lockFile}`, { force: true });
      } catch {
        // Lock file may not exist.
      }
    }
  }

  public async launchPage(toolId: string, profileId?: string): Promise<{ context: BrowserContext; page: Page }> {
    const context = await this.launchPersistent(toolId, profileId);
    const toolUrl = toolUrlFor(toolId);
    const matchingPage = toolUrl
      ? context.pages().find((page) => sameOrigin(page.url(), toolUrl))
      : undefined;

    const existingPage = matchingPage ?? context.pages().find((page) => {
      const url = page.url().trim().toLowerCase();
      return url !== "" && url !== "about:blank";
    });

    const page = existingPage ?? await context.newPage();
    if ((!existingPage || page.url().trim().toLowerCase() === "about:blank") && toolUrl) {
      await page.goto(toolUrl, { waitUntil: "domcontentloaded" }).catch(() => undefined);
    }

    return { context, page };
  }
}
