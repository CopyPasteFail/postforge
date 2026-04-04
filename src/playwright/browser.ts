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
  public async launchPersistent(toolId: string): Promise<BrowserContext> {
    const context = await chromium.launchPersistentContext(toolProfilePath(toolId), {
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

  public async launchPage(toolId: string): Promise<{ context: BrowserContext; page: Page }> {
    const context = await this.launchPersistent(toolId);
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
