import fs from "node:fs/promises";
import path from "node:path";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";

import { promptsDir } from "../config/paths.js";

export const registerNewsScoutPrompt = (server: McpServer): void => {
  server.resource(
    "news-scout-prompt",
    "linkedin://prompts/news-scout",
    { description: "AI news scout and signal filter prompt for discovering post-worthy news" },
    async () => {
      const filePath = path.join(promptsDir, "news-scout.md");
      const content = await fs.readFile(filePath, "utf8");
      return {
        contents: [{
          uri: "linkedin://prompts/news-scout",
          mimeType: "text/markdown",
          text: content,
        }],
      };
    },
  );
};
