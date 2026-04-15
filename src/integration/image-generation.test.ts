import { describe, test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { aiStudioAdapter } from "../playwright/tools/ai-studio.js";
import {
  ToolGenerationBlockedError,
  type ToolAdapter,
} from "../playwright/tools/base.js";
import { chatgptAdapter } from "../playwright/tools/chatgpt.js";
import { copilotAdapter } from "../playwright/tools/copilot.js";
import { flowAdapter } from "../playwright/tools/flow.js";
import { geminiAdapter } from "../playwright/tools/gemini.js";
import { grokAdapter } from "../playwright/tools/grok.js";

// Live integration tests that exercise every image-generation adapter on both
// paths: a safe prompt (must succeed) and a copyright-violating prompt (must
// be rejected as a content block by the adapter). Each adapter has its own
// completion-signal and block-detection code, so they are covered separately
// and sequentially.
//
// These tests drive real browsers against live third-party services, so they
// are gated behind RUN_IMAGE_INTEGRATION=1. Each adapter's Playwright profile
// must already be logged in (the same one used by the production pipeline);
// otherwise generate() will block waiting for interactive login.
//
// Usage:
//   # run every adapter, both paths
//   RUN_IMAGE_INTEGRATION=1 npm test
//
//   # run a subset only (comma-separated adapter ids)
//   RUN_IMAGE_INTEGRATION=1 IMAGE_INTEGRATION_TOOLS=ai-studio,flow npm test
//
// Per-test timeout allows for the worst observed case (~4 min) plus headroom
// for browser launch and navigation. Both paths can hit this ceiling: the
// copyright case sometimes generates the image first and only then surfaces
// the refusal banner.

const SUCCESS_PROMPT = [
  "A cozy coffee shop on a rainy afternoon, warm interior lighting, a",
  "steaming cup of latte on a wooden table next to an open notebook,",
  "raindrops on the window, soft bokeh lights outside, photorealistic",
  "style, calm and inviting atmosphere",
].join(" ");

const COPYRIGHT_PROMPT = [
  "A polished X-Men comic-book illustration set inside Xavier's School for Gifted Youngsters, styled strictly within the X-Men comic universe with no crossover characters, no external franchises, and no non-X-Men visual references. The scene is calm, intelligent, and editorial rather than chaotic, like a prestige comic panel designed to communicate a thoughtful lesson about engineering reliability.",
  "",
  "Professor Charles Xavier is the clear focal character, seated in his iconic wheelchair at the front of a futuristic teaching space inside the mansion. He is addressing a small group of X-Men gathered around him in a semi-circle, all rendered in classic comic-book form and staying fully inside the X-Men world. Include Beast with his scholarly posture and blue fur, Forge with his inventive mechanical aesthetic, and Cyclops standing attentively with composed leadership energy. Their expressions should show concentration, curiosity, and respect, as if they are studying an important systems lesson.",
  "",
  "Behind Professor X is a large holographic teaching wall built with X-Men universe technology. The display shows clean developer-documentation pages, code snippets, and clear green \"pytest passed\" indicators contrasted with a smaller faded section of broken example output. The screens should visually communicate the idea that trustworthy documentation is tested documentation. Keep all on-screen text minimal, legible, and generic, using only short phrases like \"tests passed\", \"docs\", or \"example failed\". Do not include logos, brand names, or dense paragraphs.",
  "",
  "The room should feel like a refined mutant-tech classroom inside Xavier's mansion: subtle Cerebro-inspired design language, polished metallic panels, soft blue holographic light, elegant consoles, and a high-intelligence academic atmosphere. No battle damage, no combat poses, no enemies, no explosions. This should feel like a mentorship and learning moment inside the X-Men world.",
  "",
  "Use confident comic-book linework, bold but sophisticated color blocking, balanced panel composition, and dramatic but controlled lighting. The palette should lean toward cool blues, gold accents, steel gray, and soft holographic cyan, with enough warmth in skin tones and costume colors to keep the scene human and readable. Frame it as a medium-wide shot that captures Professor X, the listening team, and the holographic documentation wall clearly. The emotional tone should be thoughtful, reliable, intelligent, and quietly inspiring.",
  "",
  "Overall goal: an X-Men-universe comic scene that visually represents trust, mentorship, and the idea that tested documentation builds confidence.",
].join("\n");

const ADAPTERS: ReadonlyArray<ToolAdapter> = [
  chatgptAdapter,
  geminiAdapter,
  aiStudioAdapter,
  flowAdapter,
  grokAdapter,
  copilotAdapter,
];

const ADAPTERS_BY_ID: Record<string, ToolAdapter> = Object.fromEntries(
  ADAPTERS.map((adapter) => [adapter.config.id, adapter] as const),
);

const runFlag = process.env["RUN_IMAGE_INTEGRATION"] === "1";
const filterEnv = process.env["IMAGE_INTEGRATION_TOOLS"] ?? process.env["IMAGE_INTEGRATION_TOOL"];
const allowed = filterEnv
  ? new Set(filterEnv.split(",").map((value) => value.trim()).filter(Boolean))
  : undefined;

const skipReason = runFlag
  ? undefined
  : "Set RUN_IMAGE_INTEGRATION=1 to run image-generation integration tests against live browsers.";

const TEST_TIMEOUT_MS = 5 * 60 * 1000;

const selectedAdapters: ReadonlyArray<ToolAdapter> = allowed
  ? ADAPTERS.filter((adapter) => allowed.has(adapter.config.id))
  : ADAPTERS;

if (runFlag && allowed) {
  const unknown = [...allowed].filter((id) => !ADAPTERS_BY_ID[id]);
  if (unknown.length > 0) {
    throw new Error(
      `Unknown adapter id(s) in IMAGE_INTEGRATION_TOOLS: ${unknown.join(", ")}. `
      + `Valid ids: ${Object.keys(ADAPTERS_BY_ID).join(", ")}`,
    );
  }
}

const prepareOutputDir = async (toolId: string, label: string): Promise<{ runId: string; outDir: string }> => {
  const runId = `${label}-${Date.now()}`;
  const outDir = path.join(os.tmpdir(), "postforge-integration", toolId, runId);
  await fs.mkdir(outDir, { recursive: true });
  return { runId, outDir };
};

// Top-level describe is skipped via option when the flag isn't set, so none
// of the per-adapter describes below get registered with the runner.
describe("image generation adapters (live browser)", { skip: skipReason, concurrency: 1 }, () => {
  for (const adapter of selectedAdapters) {
    const toolId = adapter.config.id;
    const toolName = adapter.config.name;

    describe(`${toolName} (${toolId})`, { concurrency: 1 }, () => {
      test(
        "safe coffee-shop prompt produces at least one image asset",
        { timeout: TEST_TIMEOUT_MS },
        async () => {
          const { runId, outDir } = await prepareOutputDir(toolId, "success");
          console.error(`[integration:${toolId}] running success case in ${outDir}`);

          const asset = await adapter.generate(runId, SUCCESS_PROMPT, outDir, true);

          assert.equal(
            asset.status,
            "generated",
            `expected asset.status=generated; got ${asset.status}. notes=${asset.notes ?? "<none>"}`,
          );
          assert.ok(
            asset.files.length > 0,
            `expected at least one captured artifact in ${outDir}. notes=${asset.notes ?? "<none>"}`,
          );
          for (const file of asset.files) {
            const stat = await fs.stat(file);
            assert.ok(stat.size > 0, `captured artifact should not be empty: ${file}`);
          }
        },
      );

      test(
        "X-Men prompt is rejected as a copyright/policy block",
        { timeout: TEST_TIMEOUT_MS },
        async () => {
          const { runId, outDir } = await prepareOutputDir(toolId, "copyright");
          console.error(`[integration:${toolId}] running copyright case in ${outDir}`);

          await assert.rejects(
            () => adapter.generate(runId, COPYRIGHT_PROMPT, outDir, true),
            (error: unknown) => {
              assert.ok(
                error instanceof ToolGenerationBlockedError,
                `expected ToolGenerationBlockedError; got ${(error as Error | undefined)?.constructor?.name ?? typeof error}: ${(error as Error | undefined)?.message ?? String(error)}`,
              );
              assert.ok(
                error.reason === "copyright_block" || error.reason === "policy_block",
                `expected reason=copyright_block|policy_block; got reason=${error.reason}`,
              );
              return true;
            },
          );
        },
      );
    });
  }
});
