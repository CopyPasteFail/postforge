param(
  [string]$RepoDir = "$env:USERPROFILE\.codex\postforge"
)

$ErrorActionPreference = "Stop"

Write-Host "Installing postforge to $RepoDir..."

if (-not (Test-Path $RepoDir)) {
  git clone https://github.com/CopyPasteFail/postforge.git $RepoDir
} else {
  Write-Host "Directory exists — skipping clone."
}

Set-Location $RepoDir
npm install
npx playwright install chromium
npm run build

$skillsDir = "$env:USERPROFILE\.agents\skills"
New-Item -ItemType Directory -Force $skillsDir | Out-Null

$junctionPath = "$skillsDir\postforge"
if (-not (Test-Path $junctionPath)) {
  New-Item -ItemType Junction -Path $junctionPath -Target "$RepoDir\skills" | Out-Null
  Write-Host "Skills junction created."
} else {
  Write-Host "Skills junction already exists."
}

codex mcp add linkedin-post-agent -- node "$RepoDir\dist\server.js"

Write-Host ""
Write-Host "Done. Restart Codex, then say:"
Write-Host '  "Use the linkedin-post skill from postforge and run doctor."'
