import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";

import { runDoctorChecks } from "../doctor.js";

const schema = z.object({});

export const registerDoctor = (server: McpServer): void => {
  server.tool(
    "doctor",
    "Run diagnostic checks on the pipeline setup: Node.js version, Playwright installation, Chrome availability, data directory, profiles, and enabled tools.",
    schema.shape,
    async () => {
      const result = await runDoctorChecks();

      return {
        content: [{ type: "text" as const, text: JSON.stringify({
          run_id: "n/a",
          stage: "n/a",
          allowed_actions: [],
          idempotent: true,
          data: result,
        }) }],
      };
    },
  );
};
