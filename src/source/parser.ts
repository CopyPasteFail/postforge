import type { PipelineInput } from "../pipeline/types.js";

const urlPattern = /^https?:\/\//i;

export const inferInputKind = (raw: string): PipelineInput => {
  const trimmed = raw.trim();
  if (urlPattern.test(trimmed)) {
    return {
      kind: "link",
      raw: trimmed,
      sourceLink: trimmed,
    };
  }

  if (trimmed.length > 300 || trimmed.includes("\n")) {
    return {
      kind: "draft",
      raw: trimmed,
    };
  }

  return {
    kind: "idea",
    raw: trimmed,
  };
};

export const inferStartInput = (raw: string): PipelineInput => {
  const trimmed = raw.trim();
  return inferInputKind(trimmed);
};
