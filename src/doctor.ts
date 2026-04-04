import fs from "node:fs/promises";
import path from "node:path";

import { dataDir, toolProfilePath } from "./config/paths.js";
import { imageToolConfigs } from "./config/tools.js";
import { pathExists, ensureDir } from "./storage/fs-utils.js";

interface DoctorResult {
  node_version: string;
  node_ok: boolean;
  playwright_installed: boolean;
  chrome_available: boolean;
  data_dir: string;
  data_dir_writable: boolean;
  profiles: Record<string, boolean>;
  enabled_tools: Record<string, boolean>;
  issues: string[];
  ready: boolean;
}

const checkNodeVersion = (): { version: string; ok: boolean } => {
  const version = process.version;
  const major = Number(version.replace(/^v/, "").split(".")[0]);
  return { version, ok: major >= 20 };
};

const checkPlaywright = async (): Promise<boolean> => {
  try {
    await import("playwright");
    return true;
  } catch {
    return false;
  }
};

const checkChromeAvailable = async (): Promise<boolean> => {
  try {
    const { chromium } = await import("playwright");
    const executablePath = chromium.executablePath();
    return await pathExists(executablePath);
  } catch {
    return false;
  }
};

const checkDataDirWritable = async (dir: string): Promise<boolean> => {
  try {
    await ensureDir(dir);
    const testFile = path.join(dir, ".doctor-test");
    await fs.writeFile(testFile, "ok", "utf8");
    await fs.rm(testFile, { force: true });
    return true;
  } catch {
    return false;
  }
};

const checkProfiles = async (): Promise<Record<string, boolean>> => {
  const result: Record<string, boolean> = {};
  for (const tool of imageToolConfigs) {
    result[tool.id] = await pathExists(toolProfilePath(tool.id));
  }
  result["linkedin"] = await pathExists(toolProfilePath("linkedin"));
  return result;
};

const checkEnabledTools = (): Record<string, boolean> => {
  const result: Record<string, boolean> = {};
  for (const tool of imageToolConfigs) {
    const envKey = `IMAGE_TOOL_${tool.id.replace(/-/g, "_").toUpperCase()}_ENABLED`;
    const configured = process.env[envKey];
    if (configured != null) {
      result[tool.id] = /^true$/i.test(configured);
    } else {
      result[tool.id] = tool.id !== "grok";
    }
  }
  return result;
};

export const runDoctorChecks = async (): Promise<DoctorResult> => {
  const issues: string[] = [];

  const node = checkNodeVersion();
  if (!node.ok) {
    issues.push(`Node.js version ${node.version} is below the minimum required version 20.`);
  }

  const playwrightInstalled = await checkPlaywright();
  if (!playwrightInstalled) {
    issues.push("Playwright is not installed. Run `npm install playwright` and `npx playwright install chromium`.");
  }

  const chromeAvailable = await checkChromeAvailable();
  if (!chromeAvailable) {
    issues.push("Chrome/Chromium is not available. Run `npx playwright install chromium` or set PLAYWRIGHT_CHANNEL to an installed browser.");
  }

  const dataDirWritable = await checkDataDirWritable(dataDir);
  if (!dataDirWritable) {
    issues.push(`Data directory ${dataDir} is not writable. Check permissions or set PIPELINE_DATA_DIR.`);
  }

  const profiles = await checkProfiles();
  const enabledTools = checkEnabledTools();

  const ready = node.ok && playwrightInstalled && dataDirWritable && issues.length === 0;

  return {
    node_version: node.version,
    node_ok: node.ok,
    playwright_installed: playwrightInstalled,
    chrome_available: chromeAvailable,
    data_dir: dataDir,
    data_dir_writable: dataDirWritable,
    profiles,
    enabled_tools: enabledTools,
    issues,
    ready,
  };
};
