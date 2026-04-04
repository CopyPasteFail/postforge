# linkedin-pipeline-mcp

MCP server for LinkedIn post pipeline browser automation.

## Architecture

This is a Model Context Protocol (MCP) server that wraps browser automation for AI-powered image generation and LinkedIn post preparation. It communicates over stdio.

**The host agent (Claude/Codex/Gemini) owns all reasoning.** This server owns all execution: browser automation, persistent auth, image capture, LinkedIn composer filling. The server never calls an LLM.

## Key concepts

- **Runs**: Each pipeline execution is a "run" with a UUID, persisted as JSON in the data directory
- **Stages**: Runs progress through a state machine (see src/pipeline/types.ts for RunStage)
- **Tool response envelope**: Every MCP tool returns `{ run_id, stage, allowed_actions, idempotent, data }`
- **allowed_actions**: The server tells the host agent what to call next

## Directory layout

- `src/server.ts` — MCP server entry point (stdio transport)
- `src/orchestrator.ts` — Pipeline workflow orchestration
- `src/tools/` — One file per MCP tool
- `src/resources/` — One file per MCP resource
- `src/playwright/` — Browser automation (auth, page management, tool adapters)
- `src/storage/` — Run state persistence and image asset management
- `src/config/` — Path resolution and tool configurations
- `src/pipeline/` — Type definitions and state machine helpers
- `prompts/` — Prompt files served as MCP resources (not modified by the server)

## Versions

- Server version: npm package version (1.0.0)
- Tool contract version: 1
- Run schema version: 1 (stored in every run.json)

## Build

```
npm install
npm run build
```

## Run doctor

```
node dist/server.js doctor
```
