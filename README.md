# postforge

MCP server + skill for LinkedIn post pipeline automation. One repo, two parts:

1. **MCP server** — browser automation backend for image generation and LinkedIn draft preparation
2. **Skill** — workflow instructions that any coding agent follows to write posts, generate images, and prepare drafts

The host agent (Claude Code, Codex, Gemini CLI) owns all reasoning. This server owns all execution. The server never calls an LLM and never clicks Post.

---

## Quick Start

### Prerequisites

- Node.js >= 20
- Chrome or Chromium installed

### 1. Clone and build

```bash
git clone https://github.com/CopyPasteFail/postforge.git
cd postforge
npm install
npx playwright install chromium
npm run build
```

### 2. Configure environment

```bash
cp .env.example .env
```

Edit `.env` — defaults work for most setups:

```
PIPELINE_DATA_DIR=~/.linkedin-pipeline
PLAYWRIGHT_HEADLESS=false
PLAYWRIGHT_CHANNEL=chrome
```

### 3. Wire up your agent

Pick your agent below, then complete the first-run checklist.

---

## Install: Claude Code

**Step 1 — Register the MCP server**

Add to your Claude Code MCP settings (project `.claude/settings.json` or global `~/.claude/settings.json`):

```json
{
  "mcpServers": {
    "linkedin-post-agent": {
      "command": "node",
      "args": ["/absolute/path/to/postforge/dist/server.js"]
    }
  }
}
```

**Step 2 — Restart Claude Code**

The skill (`skills/linkedin-post/SKILL.md`) and Claude-specific guidance (`CLAUDE.md`) are picked up automatically when Claude Code opens this repo.

If installed as a Claude Code plugin, the skill is also available via the `/linkedin-post` command.

**Step 3 — First-run checks** (see checklist below)

---

## Install: Codex

Tell Codex:

```
Fetch and follow instructions from https://raw.githubusercontent.com/CopyPasteFail/postforge/main/.codex/INSTALL.md
```

**Full guide:** [.codex/INSTALL.md](.codex/INSTALL.md) — covers install, verify, update, uninstall, and troubleshooting.

---

## First-Run Checklist

After wiring up your agent, verify these before your first post:

| Step | What to ask your agent | What it does |
|------|------------------------|-------------|
| 1 | "Run doctor" | Checks Node version, Playwright, Chrome, data dir, tool configs |
| 2 | "Run ensure_auth for linkedin" | Opens LinkedIn in a browser — log in manually, session is saved |
| 3 | "Run ensure_auth for chatgpt" | Same for ChatGPT (repeat for each enabled image tool) |

Repeat step 3 for every image tool you enabled in `.env` (gemini, ai-studio, flow, grok, copilot). Auth sessions persist in browser profiles — you only do this once per tool.

If `doctor` reports problems, fix them before continuing.

---

## Bootstrap Prompt

Once setup is complete, paste this into your agent to start a run:

```
Use the linkedin-post skill from postforge.

First run doctor. Then run ensure_auth for linkedin and for any image tools
you have enabled. After both pass, follow the skill workflow exactly.

If I haven't provided a link or idea, start with Phase 0 news discovery.
Never click Post automatically — stop at the ready_to_post stage and confirm with me first.
```

---

## How the Repo is Wired

```
┌─────────────────────────────────────────────────────────┐
│                    Shared (both agents)                  │
│                                                         │
│  skills/linkedin-post/SKILL.md   <- workflow brain      │
│  src/ -> dist/server.js          <- MCP server          │
│  prompts/                        <- writer & scout      │
└─────────────────────────────────────────────────────────┘

┌──────────────────────┐    ┌──────────────────────┐
│     Claude Code      │    │        Codex         │
│                      │    │                      │
│  reads: CLAUDE.md    │    │  reads: AGENTS.md    │
│  skill auto-loaded   │    │  reads: openai.yaml  │
│  from skills/ dir    │    │  skill from skills/  │
│                      │    │  MCP from yaml decl  │
│  MCP: settings.json  │    │  MCP: config.toml    │
└──────────────────────┘    └──────────────────────┘
```

| Layer | File(s) | Who reads it |
|-------|---------|-------------|
| **Shared workflow** | `skills/linkedin-post/SKILL.md` | Both agents |
| **Shared backend** | `src/` -> `dist/server.js` | Both agents (via MCP) |
| **Shared prompts** | `prompts/*.md` | MCP server (served as resources) |
| **Claude guidance** | `CLAUDE.md` | Claude Code only |
| **Codex guidance** | `AGENTS.md` | Codex only |
| **Codex metadata** | `agents/openai.yaml` | Codex only |

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

## Pipeline Stages

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
