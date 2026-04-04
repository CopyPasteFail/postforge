import fs from "node:fs/promises";
import path from "node:path";
import sharp from "sharp";

import { runPaths } from "../config/paths.js";
import { ensureDir, pathExists, resetDir, writeJson } from "./fs-utils.js";
import type { ImageAsset, ImageAssetVariant } from "../pipeline/types.js";

const imageTimestamp = (value: Date): string => {
  const year = value.getFullYear();
  const month = String(value.getMonth() + 1).padStart(2, "0");
  const day = String(value.getDate()).padStart(2, "0");
  const hours = String(value.getHours()).padStart(2, "0");
  const minutes = String(value.getMinutes()).padStart(2, "0");
  const seconds = String(value.getSeconds()).padStart(2, "0");
  return `${year}-${month}-${day} ${hours}-${minutes}-${seconds}`;
};

const sanitizeSegment = (value: string): string => value.replace(/[^a-z0-9_]+/gi, "_").replace(/^_+|_+$/g, "").toLowerCase();

export class AssetStore {
  public async ensureRunDirs(runId: string): Promise<void> {
    const dirs = runPaths(runId);
    await Promise.all([
      ensureDir(dirs.runDir),
      ensureDir(dirs.imageDir),
      ensureDir(dirs.imageTempDir),
      ensureDir(dirs.metadataDir),
      ensureDir(dirs.comparisonDir),
      ensureDir(dirs.linkedinDir),
    ]);
  }

  public async resetRunArtifacts(runId: string): Promise<void> {
    const dirs = runPaths(runId);
    await Promise.all([
      resetDir(dirs.imageDir),
      resetDir(dirs.imageTempDir),
      resetDir(dirs.metadataDir),
      resetDir(dirs.comparisonDir),
      resetDir(dirs.linkedinDir),
    ]);
  }

  public toolDir(runId: string, toolId: string): string {
    return path.join(runPaths(runId).imageTempDir, toolId);
  }

  public async ensureToolDir(runId: string, toolId: string): Promise<string> {
    const target = this.toolDir(runId, toolId);
    await ensureDir(target);
    return target;
  }

  public async writeAssetMetadata(runId: string, asset: ImageAsset): Promise<string> {
    const target = path.join(runPaths(runId).metadataDir, `${asset.toolId}.metadata.json`);
    await writeJson(target, asset);
    return target;
  }

  public async finalizeAsset(runId: string, asset: ImageAsset): Promise<ImageAsset> {
    const finalizedVariants = asset.variants
      ? await Promise.all(asset.variants.map(async (variant, index) => {
        const prefix = sanitizeSegment(variant.id.includes(":tile-")
          ? `${asset.toolId}_${variant.tileOrder ?? index + 1}`
          : `${asset.toolId}_${index + 1}`);
        const filePath = await this.moveToSharedImageDir(runId, variant.filePath, prefix);
        const nextVariant: ImageAssetVariant = {
          ...variant,
          filePath,
        };
        return nextVariant;
      }))
      : undefined;

    const finalizedFiles = finalizedVariants
      ? finalizedVariants.map((variant) => variant.filePath)
      : await Promise.all(asset.files.map((filePath, index) => this.moveToSharedImageDir(
        runId,
        filePath,
        asset.files.length > 1 ? `${asset.toolId}_${index + 1}` : asset.toolId,
      )));

    if (asset.screenshotPath && await pathExists(asset.screenshotPath)) {
      await fs.rm(asset.screenshotPath, { force: true }).catch(() => undefined);
    }

    return {
      ...asset,
      displayName: finalizedVariants && finalizedVariants.length === 1
        ? path.basename(finalizedVariants[0]!.filePath)
        : finalizedFiles.length === 1
          ? path.basename(finalizedFiles[0]!)
          : asset.displayName,
      files: finalizedFiles,
      variants: finalizedVariants,
      screenshotPath: undefined,
    };
  }

  public async convertSelectedImage(runId: string, sourcePath: string): Promise<string> {
    const extension = path.extname(sourcePath).toLowerCase();
    const targetExt = extension === ".png" ? ".jpg" : ".png";
    const targetPath = path.join(runPaths(runId).imageDir, `selected${targetExt}`);

    await fs.rm(path.join(runPaths(runId).imageDir, "selected.png"), { force: true }).catch(() => undefined);
    await fs.rm(path.join(runPaths(runId).imageDir, "selected.jpg"), { force: true }).catch(() => undefined);
    await fs.rm(path.join(runPaths(runId).imageDir, "selected.jpeg"), { force: true }).catch(() => undefined);

    if (targetExt === ".png") {
      await sharp(sourcePath).png().toFile(targetPath);
    } else {
      await sharp(sourcePath).jpeg({ quality: 92 }).toFile(targetPath);
    }

    return targetPath;
  }

  private async moveToSharedImageDir(runId: string, sourcePath: string, prefix: string): Promise<string> {
    const stats = await fs.stat(sourcePath);
    const timestamp = imageTimestamp(stats.mtime);
    const ext = path.extname(sourcePath).toLowerCase() || ".png";
    const fileName = `${sanitizeSegment(prefix)} - ${timestamp}${ext}`;
    const targetPath = path.join(runPaths(runId).imageDir, fileName);
    await fs.rename(sourcePath, targetPath);
    return targetPath;
  }
}
