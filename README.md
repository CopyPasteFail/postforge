# linkedin-post-agent

MCP server + skill for LinkedIn post pipeline automation. One repo, two parts:

1. **MCP server** -- browser automation backend for image generation and LinkedIn draft preparation
2. **Skill** -- workflow instructions that any coding agent follows to write posts, generate images, and prepare drafts

The host agent (Claude, Codex, Gemini CLI) owns all reasoning. This server owns all execution. The server never calls an LLM and never clicks Post.

## Prerequisites

- Node.js >= 20
- Chrome or Chromium installed
- Playwright browsers: `npx playwright install chromium`

## Setup

```bash
git clone https://github.com/copypastefail/linkedin-post-agent.git
cd linkedin-post-agent
npm install
npm run build
```

Copy `.env.example` to `.env` and configure:

```
PIPELINE_DATA_DIR=~/.linkedin-pipeline
PLAYWRIGHT_HEADLESS=false
PLAYWRIGHT_CHANNEL=chrome
```

Verify everything works:

```bash
node dist/server.js doctor
```

---

## Using with Codex

### 1. Configure the MCP server

Add to your Codex MCP config (`~/.codex/config.toml` or project-level `.codex/config.toml`):

```toml
[mcp_servers.linkedin-post-agent]
command = "node"
args = ["/absolute/path/to/linkedin-post-agent/dist/server.js"]
```

Or use the CLI:

```bash
codex mcp add linkedin-post-agent -- node /absolute/path/to/dist/server.js
```

### 2. Use the skill

The skill definition lives in `skills/linkedin-post/SKILL.md`. Codex metadata and MCP dependency are declared in `agents/openai.yaml`.

Point Codex at this repo and the skill will be available for the post pipeline workflow.

---

## Using with Claude Code

### 1. Configure the MCP server

Add to your Claude Code MCP settings (`.claude/settings.json` or global settings):

```json
{
  "mcpServers": {
    "linkedin-post-agent": {
      "command": "node",
      "args": ["/absolute/path/to/linkedin-post-agent/dist/server.js"]
    }
  }
}
```

### 2. Use the skill

The skill workflow is in `skills/linkedin-post/SKILL.md`. Claude-specific guidance is in `CLAUDE.md`.

If installed as a Claude Code plugin, the skill is available via the `/linkedin-post` command.

---

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

## How the repo is organized

This repo has one shared backend, one shared skill, and thin per-agent wrappers:

| Layer | File(s) | Purpose |
|-------|---------|---------|
| **Shared backend** | `src/`, `dist/` | MCP server -- browser automation, auth, image capture |
| **Shared workflow** | `skills/linkedin-post/SKILL.md` | The skill brain -- all 4 phases, MCP tool calls, stop conditions |
| **Shared prompts** | `prompts/` | Writer and news scout prompts (served as MCP resources) |
| **Codex integration** | `agents/openai.yaml` | Skill metadata + MCP dependency declaration |
| **Claude integration** | `CLAUDE.md` | Claude-specific tool preferences and MCP config |
| **Project guidance** | `AGENTS.md` | Setup, conventions, authoritative files for any coding agent |

## License

ISC
