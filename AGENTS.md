# linkedin-post-agent

Project guidance for coding agents working in this repository.

## What this repo is

A Model Context Protocol (MCP) server that wraps browser automation for AI-powered image generation and LinkedIn post preparation. It communicates over stdio. Any coding agent (Claude, Codex, Gemini CLI) can call its tools.

**The host agent owns all reasoning. This server owns all execution.**

The server never calls an LLM. It never posts to LinkedIn. Only the user clicks Post.

## Setup

```bash
npm install
npm run build
npx playwright install chromium
```

Copy `.env.example` to `.env` and configure:

```
PIPELINE_DATA_DIR=~/.linkedin-pipeline
PLAYWRIGHT_HEADLESS=false
PLAYWRIGHT_CHANNEL=chrome
```

## Running the server

```bash
node dist/server.js
```

Doctor check (runs without stdio, prints diagnostics):

```bash
node dist/server.js doctor
```

## Directory layout

- `src/server.ts` -- MCP server entry point (stdio transport)
- `src/orchestrator.ts` -- Pipeline workflow orchestration
- `src/tools/` -- One file per MCP tool (9 tools)
- `src/resources/` -- One file per MCP resource (4 resources)
- `src/playwright/` -- Browser automation: auth, page management, tool adapters
- `src/playwright/tools/` -- One adapter per AI tool (ChatGPT, Gemini, AI Studio, Flow, Grok, Copilot, LinkedIn)
- `src/storage/` -- Run state persistence and image asset management
- `src/config/` -- Path resolution and tool configurations
- `src/pipeline/` -- Type definitions and state machine helpers
- `skills/postforge/` -- Shared skill definition for the post pipeline workflow
- `agents/openai.yaml` -- Codex skill metadata and MCP dependency declaration

## Data directory

All pipeline runs are stored in `~/.linkedin-pipeline/` (configurable via `PIPELINE_DATA_DIR`):

```
~/.linkedin-pipeline/
  runs/<runId>/run.json          State persistence
  runs/<runId>/image-temp/       Temporary image files
  output/images/<runId>/         Final image assets
  output/comparisons/<runId>/    Image comparison pages
  output/linkedin/<runId>/       LinkedIn draft content
  profiles/<toolId>/             Persistent Playwright browser profiles
```

## MCP tool contract

Every MCP tool returns a response envelope:

```json
{
  "run_id": "string",
  "stage": "RunStage enum value",
  "allowed_actions": ["next_tool_to_call"],
  "idempotent": true,
  "data": {}
}
```

The `allowed_actions` array tells the host agent what to call next. Follow it.

## Pipeline stages

```
created -> awaiting_content_approval (link accessible or non-link)
created -> blocked_on_source_access (link inaccessible)
awaiting_content_approval -> awaiting_image_generation (submit_approved_copy)
awaiting_image_generation -> generating_images -> awaiting_image_selection
awaiting_image_selection -> ready_for_linkedin (select_image_candidate)
ready_for_linkedin -> ready_to_post (prepare_linkedin_draft)
```

Terminal stages: `ready_to_post`, `failed`, `archived`.

## Authoritative files

- `src/pipeline/types.ts` -- RunStage enum, RunRecord interface, all type definitions
- `src/config/tools.ts` -- Tool configurations and CSS selectors for each AI tool
- `skills/linkedin-post/SKILL.md` -- Shared skill workflow (the reasoning layer)

## Versions

- Server version: npm package version (1.0.0)
- Tool contract version: 1
- Run schema version: 1 (stored in every run.json)

## Build

```bash
npm run build        # compile TypeScript
npm run check        # type-check without emitting
```
