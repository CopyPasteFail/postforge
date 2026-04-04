import fs from "node:fs/promises";
import path from "node:path";

import { dataDir } from "../config/paths.js";
import type { PipelineInput, RunRecord, RunStage } from "../pipeline/types.js";
import { pathExists, readJson } from "../storage/fs-utils.js";

const TERMINAL_STAGES: RunStage[] = ["ready_to_post", "failed", "archived"];

export const allowedActionsForStage = (stage: RunStage): string[] => {
  switch (stage) {
    case "created":
      return ["get_run", "cancel_run"];
    case "awaiting_content_approval":
      return ["submit_approved_copy", "get_run", "cancel_run"];
    case "blocked_on_source_access":
      return ["start_run", "get_run", "cancel_run"];
    case "awaiting_chat_approval":
      return ["submit_approved_copy", "get_run", "cancel_run"];
    case "awaiting_image_generation":
    case "awaiting_image_generation_confirmation":
      return ["generate_image_candidates", "submit_approved_copy", "get_run", "cancel_run"];
    case "generating_images":
      return ["get_run", "cancel_run"];
    case "awaiting_auth":
    case "awaiting_auth_confirmation":
      return ["ensure_auth", "get_run", "cancel_run"];
    case "awaiting_image_selection":
      return ["select_image_candidate", "submit_approved_copy", "get_run", "cancel_run"];
    case "ready_for_linkedin":
      return ["prepare_linkedin_draft", "get_run", "cancel_run"];
    case "ready_to_post":
      return ["get_run"];
    case "failed":
      return ["get_run", "start_run"];
    case "archived":
      return ["get_run"];
    default:
      return ["get_run", "cancel_run"];
  }
};

const normalizeSource = (input: PipelineInput): string => {
  if (input.kind === "link") {
    return input.sourceLink.toLowerCase().replace(/\/+$/, "");
  }
  return input.raw;
};

export const findActiveRunBySource = async (input: PipelineInput): Promise<RunRecord | undefined> => {
  const runsDir = path.join(dataDir, "runs");
  if (!(await pathExists(runsDir))) {
    return undefined;
  }

  const normalizedSource = normalizeSource(input);
  const entries = await fs.readdir(runsDir, { withFileTypes: true });

  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const runFile = path.join(runsDir, entry.name, "run.json");
    if (!(await pathExists(runFile))) continue;

    try {
      const run = await readJson<RunRecord>(runFile);
      if (TERMINAL_STAGES.includes(run.stage)) continue;

      const runSource = normalizeSource(run.input);
      if (runSource === normalizedSource) {
        return run;
      }
    } catch {
      continue;
    }
  }

  return undefined;
};

export const findLatestActiveRun = async (): Promise<RunRecord | undefined> => {
  const runsDir = path.join(dataDir, "runs");
  if (!(await pathExists(runsDir))) {
    return undefined;
  }

  const entries = await fs.readdir(runsDir, { withFileTypes: true });
  let latest: RunRecord | undefined;

  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const runFile = path.join(runsDir, entry.name, "run.json");
    if (!(await pathExists(runFile))) continue;

    try {
      const run = await readJson<RunRecord>(runFile);
      if (TERMINAL_STAGES.includes(run.stage)) continue;

      if (!latest || run.updatedAt > latest.updatedAt) {
        latest = run;
      }
    } catch {
      continue;
    }
  }

  return latest;
};
