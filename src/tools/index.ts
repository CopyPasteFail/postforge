import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";

import { registerStartRun } from "./start-run.js";
import { registerSubmitApprovedCopy } from "./submit-approved-copy.js";
import { registerGenerateImageCandidates } from "./generate-image-candidates.js";
import { registerSelectImageCandidate } from "./select-image-candidate.js";
import { registerPrepareLinkedinDraft } from "./prepare-linkedin-draft.js";
import { registerEnsureAuth } from "./ensure-auth.js";
import { registerGetRun } from "./get-run.js";
import { registerCancelRun } from "./cancel-run.js";
import { registerDoctor } from "./doctor.js";
import { registerFinalizeCandidates } from "./finalize-candidates.js";
import { registerSkipTool } from "./skip-tool.js";
import { registerRetryTool } from "./retry-tool.js";

export const registerTools = (server: McpServer): void => {
  registerStartRun(server);
  registerSubmitApprovedCopy(server);
  registerGenerateImageCandidates(server);
  registerFinalizeCandidates(server);
  registerSkipTool(server);
  registerRetryTool(server);
  registerSelectImageCandidate(server);
  registerPrepareLinkedinDraft(server);
  registerEnsureAuth(server);
  registerGetRun(server);
  registerCancelRun(server);
  registerDoctor(server);
};
