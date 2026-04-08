import fs from "node:fs/promises";
import path from "node:path";

import { dataDir, outputPaths, runPaths } from "../config/paths.js";
import type { PipelineInput, RunRecord, RunStage } from "../pipeline/types.js";
import { pathExists, readJson, writeJson } from "../storage/fs-utils.js";

const TERMINAL_STAGES: RunStage[] = ["ready_to_post", "failed", "archived"];
const AUTH_STAGES: RunStage[] = ["awaiting_auth", "awaiting_auth_confirmation"];
const isCaptchaCheckpoint = (reason?: string): boolean => {
  const normalized = reason?.toLowerCase() ?? "";
  return normalized.includes("captcha") || normalized.includes("human verification");
};

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
      return ["generate_image_candidates", "retry_tool", "submit_approved_copy", "get_run", "cancel_run"];
    case "generating_images":
      return ["finalize_candidates", "get_run", "cancel_run"];
    case "awaiting_auth":
    case "awaiting_auth_confirmation":
      return ["ensure_auth", "generate_image_candidates", "skip_tool", "get_run", "cancel_run"];
    case "awaiting_image_selection":
      return ["select_image_candidate", "generate_image_candidates", "retry_tool", "submit_approved_copy", "get_run", "cancel_run"];
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

export const extractReviewPagePath = (run: RunRecord): string | undefined => {
  const note = run.notes.find((entry) => entry.startsWith("Image review file:"));
  if (!note) {
    return undefined;
  }

  const [, reviewPath] = note.split(/Image review file:\s*/, 2);
  const trimmed = reviewPath?.trim();
  return trimmed ? trimmed : undefined;
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

// Retention policy (configurable via env, values in days)
const TTL_COMPLETED = Number(process.env.RETENTION_COMPLETED_DAYS ?? 7);   // ready_to_post, archived
const TTL_FAILED    = Number(process.env.RETENTION_FAILED_DAYS    ?? 30);  // failed
const TTL_STALE     = Number(process.env.RETENTION_STALE_DAYS     ?? 3);   // never-finished active runs

const ttlForStage = (stage: RunStage): number | null => {
  if (stage === "ready_to_post" || stage === "archived") return TTL_COMPLETED;
  if (stage === "failed") return TTL_FAILED;
  // Active runs that haven't moved in a while (e.g. abandoned mid-flow)
  return TTL_STALE;
};

const deleteRunFiles = async (runId: string): Promise<void> => {
  const { runDir } = runPaths(runId);
  const { imagesDir, comparisonsDir, linkedinDir } = outputPaths(runId);
  await Promise.all([
    fs.rm(runDir, { recursive: true, force: true }),
    fs.rm(imagesDir, { recursive: true, force: true }),
    fs.rm(comparisonsDir, { recursive: true, force: true }),
    fs.rm(linkedinDir, { recursive: true, force: true }),
  ]);
};

export const purgeExpiredRuns = async (): Promise<void> => {
  const runsDir = path.join(dataDir, "runs");
  if (!(await pathExists(runsDir))) return;

  const now = Date.now();
  const entries = await fs.readdir(runsDir, { withFileTypes: true });

  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const runFile = path.join(runsDir, entry.name, "run.json");
    if (!(await pathExists(runFile))) continue;

    try {
      const run = await readJson<RunRecord>(runFile);
      const ttlDays = ttlForStage(run.stage);
      if (ttlDays === null) continue;

      const ageMs = now - new Date(run.updatedAt).getTime();
      const ageDays = ageMs / (1000 * 60 * 60 * 24);
      if (ageDays < ttlDays) continue;

      await deleteRunFiles(run.id);
      process.stderr.write(`[postforge] purged run ${run.id} (stage=${run.stage}, age=${Math.round(ageDays)}d)\n`);
    } catch {
      continue;
    }
  }
};

// Stages that may be left mid-flight when the server exits unexpectedly.
const ZOMBIE_STAGES: RunStage[] = ["generating_images", ...AUTH_STAGES];

export const recoverInterruptedRun = (run: RunRecord, now = new Date().toISOString()): boolean => {
  if (!ZOMBIE_STAGES.includes(run.stage)) {
    return false;
  }

  if (AUTH_STAGES.includes(run.stage)) {
    if (!run.pendingAuth) {
      run.stage = "awaiting_image_generation";
      run.activeToolId = undefined;
      run.activeToolName = undefined;
      run.updatedAt = now;
      run.events.push({
        at: now,
        stage: "awaiting_image_generation",
        message: "Server restarted while waiting for authentication, but the checkpoint details were missing. Image generation reset for retry.",
      });
      return true;
    }

    run.stage = "awaiting_auth";
    run.activeToolId = run.pendingAuth.toolId;
    run.activeToolName = run.pendingAuth.toolName;
    run.updatedAt = now;
    run.events.push({
      at: now,
      stage: "awaiting_auth",
      message: `Server restarted while waiting for ${run.pendingAuth.toolName} ${isCaptchaCheckpoint(run.pendingAuth.reason) ? "human verification" : "login"}; checkpoint preserved for retry.`,
    });
    return true;
  }

  run.stage = "awaiting_image_generation";
  run.activeToolId = undefined;
  run.activeToolName = undefined;
  run.pendingAuth = undefined;
  run.updatedAt = now;
  run.events.push({ at: now, stage: "awaiting_image_generation", message: "Server restarted; image generation reset for retry." });
  return true;
};

export const recoverStuckRuns = async (): Promise<void> => {
  const runsDir = path.join(dataDir, "runs");
  if (!(await pathExists(runsDir))) return;

  const entries = await fs.readdir(runsDir, { withFileTypes: true });
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const runFile = path.join(runsDir, entry.name, "run.json");
    if (!(await pathExists(runFile))) continue;

    try {
      const run = await readJson<RunRecord>(runFile);
      if (!recoverInterruptedRun(run)) continue;
      await writeJson(runFile, run);
      process.stderr.write(`[postforge] recovered stuck run ${run.id} → ${run.stage}\n`);
    } catch {
      continue;
    }
  }
};
