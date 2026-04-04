import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";

import { OrchestratorAgent } from "../orchestrator.js";
import { inferStartInput } from "../source/parser.js";
import { allowedActionsForStage } from "./helpers.js";
import { findActiveRunBySource } from "./helpers.js";

const schema = z.object({
  input_text: z.string().describe("Link URL, draft text, or rough idea"),
  input_kind: z.enum(["link", "draft", "idea"]).optional()
    .describe("Auto-detected if omitted"),
  force_new: z.boolean().default(false)
    .describe("Skip dedupe, always create a new run"),
});

export const registerStartRun = (server: McpServer): void => {
  const orchestrator = new OrchestratorAgent();

  server.tool(
    "start_run",
    "Start a new LinkedIn post pipeline run from a link, draft text, or idea. The server fetches article content for links and transitions the run to the appropriate stage.",
    schema.shape,
    async (params) => {
      const input = schema.parse(params);

      const pipelineInput = input.input_kind
        ? (() => {
          const raw = input.input_text.trim();
          if (input.input_kind === "link") {
            return { kind: "link" as const, raw, sourceLink: raw };
          }
          return { kind: input.input_kind, raw };
        })()
        : inferStartInput(input.input_text);

      if (!input.force_new) {
        const existing = await findActiveRunBySource(pipelineInput);
        if (existing) {
          const status = await orchestrator.status(existing.id);
          return {
            content: [{ type: "text" as const, text: JSON.stringify({
              run_id: existing.id,
              stage: existing.stage,
              allowed_actions: allowedActionsForStage(existing.stage),
              idempotent: true,
              data: {
                message: "Existing active run found for this source.",
                next_action: status.nextAction,
                article_source: existing.articleSource,
              },
            }) }],
          };
        }
      }

      const run = await orchestrator.startRun(pipelineInput);
      const status = await orchestrator.status(run.id);

      return {
        content: [{ type: "text" as const, text: JSON.stringify({
          run_id: run.id,
          stage: run.stage,
          allowed_actions: allowedActionsForStage(run.stage),
          idempotent: false,
          data: {
            next_action: status.nextAction,
            article_source: run.articleSource,
            fallback_message: run.stage === "blocked_on_source_access"
              ? run.notes.find((n) => n.includes("can't access"))
              : undefined,
          },
        }) }],
      };
    },
  );
};
