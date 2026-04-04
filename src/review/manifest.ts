import fs from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";

import { runPaths } from "../config/paths.js";
import type { ImageAsset, ImageAssetVariant } from "../pipeline/types.js";
import { ensureDir } from "../storage/fs-utils.js";

const htmlEscape = (value: string): string => value
  .replaceAll("&", "&amp;")
  .replaceAll("<", "&lt;")
  .replaceAll(">", "&gt;")
  .replaceAll("\"", "&quot;");

export class ReviewManifestBuilder {
  public async build(runId: string, assets: ImageAsset[]): Promise<string> {
    const targetDir = runPaths(runId).comparisonDir;
    await ensureDir(targetDir);
    const targetFile = path.join(targetDir, "index.html");

    const cards = assets.map((asset) => {
      const hasRealVariants = Boolean(asset.variants && asset.variants.length > 0);
      const variants: ImageAssetVariant[] = hasRealVariants
        ? asset.variants!
        : asset.files.map((file, index) => ({
          id: `${asset.id}:file-${index + 1}`,
          label: `${asset.toolName} Candidate ${index + 1}`,
          filePath: file,
        } as ImageAssetVariant));

      const media = variants.length > 0
        ? variants.map((variant) => this.renderVariant(runId, asset, variant, hasRealVariants)).join("\n")
        : asset.screenshotPath
          ? `<img src="${htmlEscape(pathToFileURL(asset.screenshotPath).toString())}" alt="${htmlEscape(asset.toolName)} screenshot" />`
          : `<p>No media was captured automatically.</p>`;

      return `
        <section class="card">
          <h2>${htmlEscape(asset.toolName)}</h2>
          <p><strong>Asset ID:</strong> ${htmlEscape(asset.id)}</p>
          <p><strong>Status:</strong> ${htmlEscape(asset.status)}</p>
          <p>${htmlEscape(asset.notes ?? "")}</p>
          <div class="media">${media}</div>
        </section>
      `;
    }).join("\n");

    const html = `
      <!doctype html>
      <html lang="en">
        <head>
          <meta charset="utf-8" />
          <title>Image Review - ${htmlEscape(runId)}</title>
          <style>
            body {
              font-family: Georgia, "Times New Roman", serif;
              margin: 32px;
              background: linear-gradient(180deg, #f6efe7 0%, #f1f4f8 100%);
              color: #1e2430;
            }
            h1 {
              margin-bottom: 24px;
            }
            .grid {
              display: grid;
              grid-template-columns: repeat(auto-fit, minmax(360px, 1fr));
              gap: 20px;
            }
            .card {
              background: rgba(255, 255, 255, 0.9);
              border: 1px solid rgba(30, 36, 48, 0.1);
              border-radius: 16px;
              padding: 20px;
              box-shadow: 0 12px 30px rgba(30, 36, 48, 0.08);
            }
            .media {
              display: grid;
              gap: 12px;
              margin-top: 16px;
            }
            .variant {
              border: 1px solid rgba(30, 36, 48, 0.12);
              border-radius: 12px;
              padding: 12px;
              background: rgba(246, 239, 231, 0.55);
              cursor: pointer;
              transition: transform 120ms ease, box-shadow 120ms ease, border-color 120ms ease;
            }
            .variant:hover {
              transform: translateY(-1px);
              box-shadow: 0 8px 20px rgba(30, 36, 48, 0.08);
            }
            .variant.selected {
              border-color: #1f6feb;
              box-shadow: 0 0 0 3px rgba(31, 111, 235, 0.16);
            }
            .variant h3 {
              margin: 0 0 8px;
              font-size: 1rem;
            }
            .variant p {
              margin: 4px 0;
              font-size: 0.95rem;
            }
            img {
              width: 100%;
              border-radius: 12px;
              border: 1px solid rgba(30, 36, 48, 0.12);
            }
            .select-bar {
              position: sticky;
              top: 16px;
              z-index: 10;
              margin-bottom: 20px;
              padding: 16px;
              border-radius: 14px;
              background: rgba(255, 255, 255, 0.94);
              border: 1px solid rgba(30, 36, 48, 0.12);
              box-shadow: 0 8px 24px rgba(30, 36, 48, 0.1);
            }
            .select-bar p {
              margin: 6px 0;
            }
            .select-actions {
              display: flex;
              gap: 10px;
              margin-top: 10px;
              flex-wrap: wrap;
            }
            .select-actions button {
              border: 0;
              border-radius: 999px;
              background: #1f6feb;
              color: white;
              padding: 10px 14px;
              font: inherit;
              cursor: pointer;
            }
            .select-actions code {
              display: block;
              width: 100%;
              overflow-wrap: anywhere;
              background: #f3f6fb;
              border-radius: 10px;
              padding: 10px 12px;
            }
            .select-actions button.secondary {
              background: #e7eef8;
              color: #1e2430;
            }
          </style>
        </head>
        <body>
          <h1>Image Review for Run ${htmlEscape(runId)}</h1>
          <section class="select-bar">
            <p><strong>Selection:</strong> <span id="selection-label">Nothing selected yet</span></p>
            <p id="selection-help">Click a candidate card below to highlight it, open that image folder, and generate the exact <code>pick-image</code> command for that image.</p>
            <p><strong>Image File:</strong> <span id="selection-file">No image selected yet</span></p>
            <div class="select-actions">
              <button id="open-folder" class="secondary" type="button">Open Image Folder</button>
              <button id="copy-image-path" class="secondary" type="button">Copy Image Path</button>
              <button id="copy-command" type="button">Copy Selection Command</button>
              <code id="selection-command">pick-image command will appear here</code>
            </div>
          </section>
          <div class="grid">${cards}</div>
          <script>
            (() => {
              const labelNode = document.getElementById("selection-label");
              const commandNode = document.getElementById("selection-command");
              const copyButton = document.getElementById("copy-command");
              const copyImagePathButton = document.getElementById("copy-image-path");
              const openFolderButton = document.getElementById("open-folder");
              const fileNode = document.getElementById("selection-file");
              let currentCommand = "";
              let currentImagePath = "";
              let currentFolderUrl = "";
              let lastOpenedFolderUrl = "";

              const buildCommand = (element) => {
                const runId = element.dataset.runId;
                const assetId = element.dataset.assetId;
                const variantId = element.dataset.variantId;
                let command = \`npx tsx src/index.ts pick-image --run \${runId} --asset \${assetId}\`;
                if (variantId) {
                  command += \` --variant \${variantId}\`;
                }
                return command;
              };

              const selectVariant = (element) => {
                document.querySelectorAll(".variant.selected").forEach((node) => node.classList.remove("selected"));
                element.classList.add("selected");
                const label = element.dataset.label || "Unknown selection";
                currentCommand = buildCommand(element);
                currentImagePath = element.dataset.filePath || "";
                currentFolderUrl = element.dataset.folderUrl || "";
                if (labelNode) labelNode.textContent = label;
                if (commandNode) commandNode.textContent = currentCommand;
                if (fileNode) fileNode.textContent = currentImagePath || "No image selected yet";
                if (currentFolderUrl && currentFolderUrl !== lastOpenedFolderUrl) {
                  window.open(currentFolderUrl, "_blank");
                  lastOpenedFolderUrl = currentFolderUrl;
                }
              };

              document.querySelectorAll(".variant").forEach((element) => {
                element.addEventListener("click", () => selectVariant(element));
              });

              if (copyButton) {
                copyButton.addEventListener("click", async () => {
                  if (!currentCommand) return;
                  try {
                    await navigator.clipboard.writeText(currentCommand);
                    copyButton.textContent = "Copied";
                    window.setTimeout(() => { copyButton.textContent = "Copy Selection Command"; }, 1200);
                  } catch {
                    copyButton.textContent = "Copy Failed";
                    window.setTimeout(() => { copyButton.textContent = "Copy Selection Command"; }, 1200);
                  }
                });
              }

              if (copyImagePathButton) {
                copyImagePathButton.addEventListener("click", async () => {
                  if (!currentImagePath) return;
                  try {
                    await navigator.clipboard.writeText(currentImagePath);
                    copyImagePathButton.textContent = "Copied";
                    window.setTimeout(() => { copyImagePathButton.textContent = "Copy Image Path"; }, 1200);
                  } catch {
                    copyImagePathButton.textContent = "Copy Failed";
                    window.setTimeout(() => { copyImagePathButton.textContent = "Copy Image Path"; }, 1200);
                  }
                });
              }

              if (openFolderButton) {
                openFolderButton.addEventListener("click", () => {
                  if (!currentFolderUrl) return;
                  window.open(currentFolderUrl, "_blank");
                });
              }
            })();
          </script>
        </body>
      </html>
    `;

    await fs.writeFile(targetFile, html, "utf8");
    return targetFile;
  }

  private renderVariant(runId: string, asset: ImageAsset, variant: ImageAssetVariant, hasRealVariants: boolean): string {
    const metadataBits = [
      variant.tileOrder ? `<p><strong>Tile:</strong> ${variant.tileOrder}</p>` : "",
      variant.downloadKind ? `<p><strong>Download:</strong> ${htmlEscape(variant.downloadKind)}</p>` : "",
      variant.width && variant.height ? `<p><strong>Size:</strong> ${variant.width}x${variant.height}</p>` : "",
      variant.sourceUrl ? `<p><strong>Source:</strong> ${htmlEscape(variant.sourceUrl)}</p>` : "",
      variant.metadataPath ? `<p><strong>Metadata:</strong> ${htmlEscape(variant.metadataPath)}</p>` : "",
    ].filter(Boolean).join("\n");

    return `
      <div
        class="variant"
        data-run-id="${htmlEscape(runId)}"
        data-asset-id="${htmlEscape(asset.id)}"
        data-variant-id="${hasRealVariants ? htmlEscape(variant.id) : ""}"
        data-label="${htmlEscape(`${asset.toolName} - ${variant.label}`)}"
        data-file-path="${htmlEscape(variant.filePath)}"
        data-folder-url="${htmlEscape(pathToFileURL(`${path.dirname(variant.filePath)}${path.sep}`).toString())}"
      >
        <h3>${htmlEscape(variant.label)}</h3>
        ${metadataBits}
        <img src="${htmlEscape(pathToFileURL(variant.filePath).toString())}" alt="${htmlEscape(asset.toolName)} ${htmlEscape(variant.label)}" />
      </div>
    `;
  }
}
