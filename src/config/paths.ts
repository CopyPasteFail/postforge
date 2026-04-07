import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const resolveDataDir = (): string => {
  const configured = process.env.PIPELINE_DATA_DIR;
  if (configured) {
    if (configured.startsWith("~")) {
      return path.join(os.homedir(), configured.slice(1));
    }
    return path.resolve(configured);
  }
  return path.join(os.homedir(), ".linkedin-pipeline");
};

export const dataDir = resolveDataDir();

export const runPaths = (runId: string) => ({
  runDir: path.join(dataDir, "runs", runId),
  runFile: path.join(dataDir, "runs", runId, "run.json"),
  imageDir: path.join(dataDir, "output", "images", runId),
  imageTempDir: path.join(dataDir, "runs", runId, "image-temp"),
  metadataDir: path.join(dataDir, "runs", runId, "metadata"),
  comparisonDir: path.join(dataDir, "output", "comparisons", runId),
  linkedinDir: path.join(dataDir, "output", "linkedin", runId),
});

export const toolProfilePath = (toolId: string): string =>
  path.join(dataDir, "profiles", toolId);

export const outputPaths = (runId: string) => ({
  imagesDir: path.join(dataDir, "output", "images", runId),
  comparisonsDir: path.join(dataDir, "output", "comparisons", runId),
  linkedinDir: path.join(dataDir, "output", "linkedin", runId),
});

// path to bundled prompt files (resolved relative to the compiled server)
// dist/config/paths.js → up two levels → project root → prompts/
export const promptsDir = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
  "..",
  "prompts",
);
