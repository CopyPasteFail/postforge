import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";

import { OrchestratorAgent } from "../orchestrator.js";
import { allowedActionsForStage } from "./helpers.js";

const schema = z.object({
  run_id: z.string(),
});

export const registerPrepareLinkedinDraft = (server: McpServer): void => {
  const orchestrator = new OrchestratorAgent();

  server.tool(
    "prepare_linkedin_draft",
    "Open LinkedIn in a persistent Playwright browser, fill the composer with the approved post text, save as draft, and open the selected image folder for manual attachment. Never clicks Post.",
    schema.shape,
    async (params) => {
      const input = schema.parse(params);
      let run: Awaited<ReturnType<typeof orchestrator.prepareLinkedIn>>;
      try {
        run = await orchestrator.prepareLinkedIn(input.run_id);
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        return { content: [{ type: "text" as const, text: JSON.stringify({ error: message }) }], isError: true };
      }

      // If the orchestrator caught an AuthRequiredError, the stage will be
      // "awaiting_auth" with pendingAuth set.  Surface this clearly so the
      // caller can relay the auth_required message to the user immediately.
      if (run.stage === "awaiting_auth" && run.pendingAuth) {
        return {
          content: [{ type: "text" as const, text: JSON.stringify({
            run_id: run.id,
            stage: run.stage,
            allowed_actions: allowedActionsForStage(run.stage),
            idempotent: true,
            data: {
              auth_required: {
                tool_id: run.pendingAuth.toolId,
                tool_name: run.pendingAuth.toolName,
                url: run.pendingAuth.url,
                reason: run.pendingAuth.reason,
                next_step: `LinkedIn is not logged in. Please log in at ${run.pendingAuth.url}, then call ensure_auth('linkedin') to verify, then call prepare_linkedin_draft again.`,
              },
            },
          }) }],
        };
      }

      return {
        content: [{ type: "text" as const, text: JSON.stringify({
          run_id: run.id,
          stage: run.stage,
          allowed_actions: allowedActionsForStage(run.stage),
          idempotent: false,
          data: {
            message: "LinkedIn composer filled and draft saved. Image folder opened. Click Post manually.",
          },
        }) }],
      };
    },
  );
};
