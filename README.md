# linkedin-post-agent

MCP server for LinkedIn post pipeline browser automation. Exposes tools over stdio that any coding agent (Claude, Codex, Gemini CLI) can call to automate image generation across free AI tools and LinkedIn post preparation via Playwright.

## What it does

The host agent writes posts and generates image prompts. This server handles:

- **Browser automation** across ChatGPT, Gemini, AI Studio, Flow, Grok, and Copilot for image generation
- **Persistent auth** via Playwright browser profiles
- **Image capture** and comparison page generation
- **LinkedIn composer** filling and draft saving

## Prerequisites

- Node.js >= 20
- Chrome or Chromium installed
- Playwright browsers: `npx playwright install chromium`

## Setup

```bash
npm install
npm run build
```

Copy `.env.example` to `.env` and configure:

```
PIPELINE_DATA_DIR=~/.linkedin-pipeline
PLAYWRIGHT_HEADLESS=false
PLAYWRIGHT_CHANNEL=chrome
```

## Usage

### As an MCP server (stdio)

Add to your MCP client configuration:

```json
{
  "mcpServers": {
    "linkedin-post-agent": {
      "command": "node",
      "args": ["path/to/dist/server.js"]
    }
  }
}
```

### Doctor check

```bash
node dist/server.js doctor
```

## MCP Tools

| Tool | Description |
|------|-------------|
| `start_run` | Start a new pipeline run from a link, draft, or idea |
| `submit_approved_copy` | Submit approved post text and image prompt |
| `generate_image_candidates` | Run image generation across enabled AI tools |
| `select_image_candidate` | Select an image by candidate number |
| `prepare_linkedin_draft` | Fill LinkedIn composer and save as draft |
| `ensure_auth` | Ensure authentication for a specific tool |
| `get_run` | Get full run state |
| `cancel_run` | Cancel an active run |
| `doctor` | Run diagnostic checks |

## MCP Resources

| URI | Description |
|-----|-------------|
| `linkedin://prompts/writer` | LinkedIn post writer system prompt |
| `linkedin://prompts/news-scout` | AI news scout prompt |
| `linkedin://config/tools` | Current tool configuration |
| `linkedin://runs/latest` | Most recent active run |

## Pipeline stages

```
created -> awaiting_content_approval (link accessible or non-link)
created -> blocked_on_source_access (link inaccessible)
awaiting_content_approval -> awaiting_image_generation (submit_approved_copy)
awaiting_image_generation -> generating_images -> awaiting_image_selection
awaiting_image_selection -> ready_for_linkedin (select_image_candidate)
ready_for_linkedin -> ready_to_post (prepare_linkedin_draft)
```

Terminal stages: `ready_to_post`, `failed`, `archived`

## License

ISC
