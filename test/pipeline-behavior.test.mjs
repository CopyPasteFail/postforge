import test from "node:test";
import assert from "node:assert/strict";

import { ImageRunnerAgent } from "../dist/agents/image-runner.js";
import { CaptchaRequiredError } from "../dist/playwright/auth.js";
import { summarizeNextAction } from "../dist/pipeline/checkpoints.js";
import {
  recoverInterruptedRun,
  allowedActionsForStage,
  extractReviewPagePath,
} from "../dist/tools/helpers.js";
import { runPaths } from "../dist/config/paths.js";

const withToolEnv = async (overrides, fn) => {
  const previous = new Map();
  for (const [key, value] of Object.entries(overrides)) {
    previous.set(key, process.env[key]);
    process.env[key] = value;
  }

  try {
    await fn();
  } finally {
    for (const [key, value] of previous.entries()) {
      if (value == null) {
        delete process.env[key];
      } else {
        process.env[key] = value;
      }
    }
  }
};

const buildRun = () => ({
  id: "run-123",
  schema_version: 1,
  createdAt: "2026-04-08T00:00:00.000Z",
  updatedAt: "2026-04-08T00:00:00.000Z",
  stage: "generating_images",
  workflowMode: "chat",
  input: { kind: "idea", raw: "test prompt" },
  imageAssets: [],
  latestResponseIds: {},
  notes: [],
  events: [],
  finalImagePrompt: {
    promptText: "Generate something",
    copyBlock: "```Generate something```",
    confirmationQuestion: "Generate this image?",
  },
});

test("runAll rethrows CAPTCHA checkpoints instead of downgrading them to warnings", async () => {
  await withToolEnv({
    IMAGE_TOOL_CHATGPT_ENABLED: "false",
    IMAGE_TOOL_GEMINI_ENABLED: "false",
    IMAGE_TOOL_AI_STUDIO_ENABLED: "false",
    IMAGE_TOOL_FLOW_ENABLED: "false",
    IMAGE_TOOL_GROK_ENABLED: "false",
    IMAGE_TOOL_COPILOT_ENABLED: "true",
  }, async () => {
    const assets = {
      resetRunArtifacts: async () => undefined,
      ensureRunDirs: async () => undefined,
    };
    const manifestBuilder = {
      build: async () => {
        throw new Error("manifest should not be built when CAPTCHA pauses the run");
      },
    };

    const agent = new ImageRunnerAgent(assets, manifestBuilder);
    agent.runSingleTool = async () => {
      throw new CaptchaRequiredError({
        toolId: "copilot",
        toolName: "Copilot",
        url: "https://copilot.microsoft.com/",
        reason: "Copilot is showing a human verification challenge (CAPTCHA). Please complete it in the browser and retry.",
        requestedAt: "2026-04-08T00:00:00.000Z",
      });
    };

    const started = [];
    const completed = [];

    await assert.rejects(
      agent.runAll(buildRun(), true, {
        onToolStart: async (toolId, toolName) => {
          started.push([toolId, toolName]);
        },
        onToolComplete: async (asset) => {
          completed.push(asset);
        },
      }),
      (error) => {
        assert.ok(error instanceof CaptchaRequiredError);
        assert.equal(error.checkpoint.toolId, "copilot");
        return true;
      },
    );

    assert.deepEqual(started, [["copilot", "Copilot"]]);
    assert.deepEqual(completed, []);
  });
});

test("recoverInterruptedRun preserves auth checkpoints across server restarts", () => {
  const run = {
    ...buildRun(),
    stage: "awaiting_auth",
    pendingAuth: {
      toolId: "copilot",
      toolName: "Copilot",
      url: "https://copilot.microsoft.com/",
      reason: "Copilot is showing a human verification challenge (CAPTCHA). Please complete it in the browser and retry.",
      requestedAt: "2026-04-08T00:00:00.000Z",
    },
    activeToolId: "copilot",
    activeToolName: "Copilot",
  };

  const recovered = recoverInterruptedRun(run, "2026-04-08T01:00:00.000Z");

  assert.equal(recovered, true);
  assert.equal(run.stage, "awaiting_auth");
  assert.equal(run.pendingAuth?.toolId, "copilot");
  assert.equal(run.activeToolId, "copilot");
  assert.match(run.events.at(-1)?.message ?? "", /checkpoint preserved for retry/i);
});

test("awaiting_auth guidance and allowed actions cover CAPTCHA resume flows", () => {
  const run = {
    ...buildRun(),
    stage: "awaiting_auth",
    pendingAuth: {
      toolId: "copilot",
      toolName: "Copilot",
      url: "https://copilot.microsoft.com/",
      reason: "Copilot is showing a human verification challenge (CAPTCHA). Please complete it in the browser and retry.",
      requestedAt: "2026-04-08T00:00:00.000Z",
    },
  };

  assert.match(summarizeNextAction(run), /generate_image_candidates/);
  assert.ok(allowedActionsForStage("awaiting_auth").includes("generate_image_candidates"));
});

test("extractReviewPagePath returns the absolute review file path from run notes", () => {
  const run = {
    ...buildRun(),
    id: "run-456",
    notes: [`Image review file: ${runPaths("run-456").comparisonDir}\\index.html`],
  };

  assert.equal(
    extractReviewPagePath(run),
    `${runPaths("run-456").comparisonDir}\\index.html`,
  );
});
