# Installing postforge for Codex

Enable the LinkedIn post pipeline in Codex via native skill discovery.

## Prerequisites

- Git
- Node.js >= 20
- Chrome or Chromium

## Installation

### macOS / Linux

1. **Clone and build:**
   ```bash
   git clone https://github.com/CopyPasteFail/postforge.git ~/.codex/postforge
   cd ~/.codex/postforge
   npm install
   npx playwright install chromium
   npm run build
   ```

2. **Create the skills symlink:**
   ```bash
   mkdir -p ~/.agents/skills
   ln -s ~/.codex/postforge/skills ~/.agents/skills/postforge
   ```

3. **Register the MCP server:**
   ```bash
   codex mcp add linkedin-post-agent -- node ~/.codex/postforge/dist/server.js
   ```

4. **Restart Codex** to discover the skills.

### Windows (PowerShell)

1. **Clone and build:**
   ```powershell
   git clone https://github.com/CopyPasteFail/postforge.git "$env:USERPROFILE\.codex\postforge"
   Set-Location "$env:USERPROFILE\.codex\postforge"
   npm install
   npx playwright install chromium
   npm run build
   ```

2. **Create the skills junction:**
   ```powershell
   New-Item -ItemType Directory -Force "$env:USERPROFILE\.agents\skills"
   New-Item -ItemType Junction -Path "$env:USERPROFILE\.agents\skills\postforge" `
     -Target "$env:USERPROFILE\.codex\postforge\skills"
   ```

3. **Register the MCP server:**
   ```powershell
   codex mcp add linkedin-post-agent -- node "$env:USERPROFILE\.codex\postforge\dist\server.js"
   ```

4. **Restart Codex** to discover the skills.

## Verify

```bash
ls -la ~/.agents/skills/postforge
```

You should see a symlink (or junction on Windows) pointing to your postforge skills directory.

Then tell Codex:

```
Use the linkedin-post skill from postforge and run doctor.
```

## First-run auth

After `doctor` passes, authenticate each tool you plan to use:

```
Run ensure_auth for linkedin
Run ensure_auth for chatgpt
```

Repeat for each enabled image tool (`gemini`, `ai-studio`, `flow`, `grok`, `copilot`). Auth sessions persist in browser profiles — you only do this once per tool.

## Updating

```bash
cd ~/.codex/postforge && git pull && npm install && npm run build
```

Skills update instantly through the symlink. Restart Codex after a build update.

## Uninstalling

```bash
rm ~/.agents/skills/postforge
codex mcp remove linkedin-post-agent
```

Optionally delete the clone:

```bash
rm -rf ~/.codex/postforge
```

**Windows:**

```powershell
Remove-Item "$env:USERPROFILE\.agents\skills\postforge"
codex mcp remove linkedin-post-agent
Remove-Item -Recurse -Force "$env:USERPROFILE\.codex\postforge"
```

## Troubleshooting

**Skills not discovered after restart**
- Verify the symlink: `ls -la ~/.agents/skills/postforge`
- On Windows: `Get-Item "$env:USERPROFILE\.agents\skills\postforge"`
- Confirm it points to the postforge `skills/` directory, not the repo root

**MCP server not reachable**
- Confirm the build exists: `ls ~/.codex/postforge/dist/server.js`
- Rebuild: `cd ~/.codex/postforge && npm run build`
- Re-register: `codex mcp add linkedin-post-agent -- node ~/.codex/postforge/dist/server.js`

**doctor reports Playwright not found**
- Re-run: `cd ~/.codex/postforge && npx playwright install chromium`

**Auth sessions lost after system update**
- Re-run `ensure_auth` for the affected tool. Sessions live in `~/.linkedin-pipeline` (or your `PIPELINE_DATA_DIR`).

**Windows junction creation requires elevation**
- Run PowerShell as Administrator, or use `mklink /J` in an elevated Command Prompt:
  ```
  mklink /J "%USERPROFILE%\.agents\skills\postforge" "%USERPROFILE%\.codex\postforge\skills"
  ```
