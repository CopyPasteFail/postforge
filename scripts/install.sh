#!/usr/bin/env bash
set -euo pipefail

REPO_DIR="${1:-$HOME/.codex/postforge}"

echo "Installing postforge to $REPO_DIR..."

if [ ! -d "$REPO_DIR" ]; then
  git clone https://github.com/CopyPasteFail/postforge.git "$REPO_DIR"
else
  echo "Directory exists — skipping clone."
fi

cd "$REPO_DIR"
npm install
npx playwright install chromium
npm run build

mkdir -p "$HOME/.agents/skills"

if [ ! -e "$HOME/.agents/skills/postforge" ]; then
  ln -s "$REPO_DIR/skills" "$HOME/.agents/skills/postforge"
  echo "Skills symlink created."
else
  echo "Skills symlink already exists."
fi

codex mcp add linkedin-post-agent -- node "$REPO_DIR/dist/server.js"

echo ""
echo "Done. Restart Codex, then say:"
echo '  "Use the linkedin-post skill from postforge and run doctor."'
