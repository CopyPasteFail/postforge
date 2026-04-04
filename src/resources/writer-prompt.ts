import fs from "node:fs/promises";
import path from "node:path";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";

import { promptsDir } from "../config/paths.js";

export const registerWriterPrompt = (server: McpServer): void => {
  server.resource(
    "writer-prompt",
    "linkedin://prompts/writer",
    { description: "LinkedIn post writer system prompt with voice rules, structure blueprint, and two-turn workflow" },
    async () => {
      const filePath = path.join(promptsDir, "linkedin-writer.md");
      const content = await fs.readFile(filePath, "utf8");
      return {
        contents: [{
          uri: "linkedin://prompts/writer",
          mimeType: "text/markdown",
          text: content,
        }],
      };
    },
  );
};
