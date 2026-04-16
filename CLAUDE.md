# Claude-specific guidance

This file contains instructions for Claude Code when working with or invoking the linkedin-post skill.

## Skill location

The shared workflow lives in `skills/postforge/SKILL.md`. Follow it as the single source of truth for the post pipeline.

## MCP server

The `linkedin-post-agent` MCP server must be configured in the user's Claude Code MCP settings. It communicates over stdio:

```json
{
  "mcpServers": {
    "linkedin-post-agent": {
      "command": "node",
      "args": ["/absolute/path/to/dist/server.js"]
    }
  }
}
```

## Web discovery (Phase 0)

When the skill calls for web search and fetch during news discovery, use Claude Code's native `WebSearch` and `WebFetch` tools. These are the preferred tools for this phase.

## Tool calling

All pipeline execution goes through MCP tool calls to `linkedin-post-agent`. Claude does the reasoning (writing, prompt crafting, decision-making). The server does the execution (browsers, auth, image capture, LinkedIn composer).

Never attempt to automate browsers or call external APIs directly. Always go through the MCP tools.

