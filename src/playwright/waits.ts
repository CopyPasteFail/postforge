import type { Page } from "playwright";

export const delay = async (ms: number): Promise<void> => {
  await new Promise((resolve) => setTimeout(resolve, ms));
};

export const waitForAnySelector = async (
  page: Page,
  selectors: string[],
  timeoutMs = 10_000,
): Promise<string | undefined> => {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    for (const selector of selectors) {
      const locator = page.locator(selector).first();
      if ((await locator.count()) > 0 && (await locator.isVisible().catch(() => false))) {
        return selector;
      }
    }

    await delay(250);
  }

  return undefined;
};

export const waitForBusyToSettle = async (
  page: Page,
  busySelectors: string[],
  timeoutMs = 90_000,
): Promise<void> => {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    let anyBusy = false;
    for (const selector of busySelectors) {
      const locator = page.locator(selector).first();
      if ((await locator.count()) > 0 && (await locator.isVisible().catch(() => false))) {
        anyBusy = true;
        break;
      }
    }

    if (!anyBusy) {
      return;
    }

    await delay(750);
  }
};
