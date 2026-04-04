import fs from "node:fs/promises";
import path from "node:path";

export const ensureDir = async (dirPath: string): Promise<void> => {
  await fs.mkdir(dirPath, { recursive: true });
};

export const readUtf8 = async (filePath: string): Promise<string> => {
  return fs.readFile(filePath, "utf8");
};

export const writeJson = async (filePath: string, data: unknown): Promise<void> => {
  await ensureDir(path.dirname(filePath));
  await fs.writeFile(filePath, `${JSON.stringify(data, null, 2)}\n`, "utf8");
};

export const readJson = async <T>(filePath: string): Promise<T> => {
  const raw = await readUtf8(filePath);
  return JSON.parse(raw) as T;
};

export const pathExists = async (filePath: string): Promise<boolean> => {
  try {
    await fs.access(filePath);
    return true;
  } catch {
    return false;
  }
};

export const resetDir = async (dirPath: string): Promise<void> => {
  await fs.rm(dirPath, { recursive: true, force: true });
  await ensureDir(dirPath);
};
