import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";

import { findLatestActiveRun } from "../tools/helpers.js";

export const registerLatestRun = (server: McpServer): void => {
  server.resource(
    "latest-run",
    "linkedin://runs/latest",
    { description: "The most recent non-terminal pipeline run, or a message if no active runs exist" },
    async () => {
      const run = await findLatestActiveRun();

      if (!run) {
        return {
          contents: [{
            uri: "linkedin://runs/latest",
            mimeType: "application/json",
            text: JSON.stringify({ message: "No active pipeline runs found." }),
          }],
        };
      }

      return {
        contents: [{
          uri: "linkedin://runs/latest",
          mimeType: "application/json",
          text: JSON.stringify(run, null, 2),
        }],
      };
    },
  );
};
