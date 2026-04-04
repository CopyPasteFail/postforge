---
name: using-postforge
description: "Read before any postforge task. Covers when to invoke the linkedin-post pipeline, when to run diagnostics, when to authenticate, and the hard constraints that must never be violated."
---

# Using Postforge

Postforge is a two-part system:

- **Skill** (`linkedin-post`) — reasoning: writing, prompting, deciding
- **MCP server** (`linkedin-post-agent`) — execution: browser automation, persistent auth, image capture, LinkedIn composer

The skill drives the pipeline. The MCP server executes it. Neither part posts to LinkedIn — only the user does.

---

## When to invoke the linkedin-post skill

Invoke `linkedin-post` whenever the user wants to:

- Write, draft, polish, or publish a LinkedIn post
- Turn a link, article, or idea into a post
- Generate images for a post
- Run news discovery or find a topic
- Run doctor, ensure_auth, or any pipeline phase

If there is a 10% or greater chance the user wants the LinkedIn pipeline, read `linkedin-post` before responding.

---

## Session start checklist

Before beginning any pipeline run:

1. Confirm `linkedin-post-agent` MCP server is reachable by calling `doctor`.
   - If the server is not found, tell the user to run `install.sh` (or `install.ps1` on Windows) from the repo root and restart Codex.
2. If `doctor` reports a failure, resolve it before proceeding. Do not start a run on a broken environment.
3. If `doctor` reports missing auth for any tool the user plans to use, call `ensure_auth` for that tool first.

---

## Skill invocation order

1. `using-postforge` — read at session start (this file)
2. `linkedin-post` — follow for the full pipeline

---

## Hard constraints — never violate

- **Never click Post.** The pipeline ends at `ready_to_post`. The user always clicks Post manually in their browser.
- **Never start image generation before the user approves post copy.** Phase 2 only begins after the user signs off on the text.
- **Never invent facts.** If a source link is inaccessible, use the exact fallback line from the `linkedin-post` skill and stop.
- **Never call `prepare_linkedin_draft` without an approved post and a selected image.** Both must be confirmed before touching the LinkedIn composer.

---

## Diagnostics

Run `doctor` any time:
- Tools are unresponsive
- Browsers don't open
- Something seems broken mid-pipeline

Report the full doctor output to the user before continuing.

---

## Authentication

If any tool call returns `auth_required` or fails with an auth error:

1. Tell the user which tool needs login.
2. Call `ensure_auth` with the tool ID.
3. The tool opens a browser — the user logs in manually.
4. After auth succeeds, retry the original operation.

Tool IDs: `linkedin`, `chatgpt`, `gemini`, `ai-studio`, `flow`, `grok`, `copilot`

Auth sessions persist across runs. Users only authenticate once per tool.

---

## Updating postforge

```bash
cd ~/.codex/postforge && git pull && npm install && npm run build
```

Skills update instantly through the symlink. Restart Codex after a build update.
