import type { ToolId } from "../config/tools.js";

export type InputKind = "link" | "draft" | "idea";
export type WorkflowMode = "chat" | "repo-writer";

interface BaseInput {
  raw: string;
  sourceLink?: string | undefined;
}

export interface LinkInput extends BaseInput {
  kind: "link";
  sourceLink: string;
}

export interface DraftInput extends BaseInput {
  kind: "draft";
}

export interface IdeaInput extends BaseInput {
  kind: "idea";
}

export type DirectPipelineInput = LinkInput | DraftInput | IdeaInput;
export type PipelineInput = DirectPipelineInput;

export interface ArticleSource {
  url: string;
  title?: string | undefined;
  text?: string | undefined;
  accessible: boolean;
  reason?: string | undefined;
}

export interface DraftVariation {
  label: "A" | "B" | "C" | "D" | "E";
  body: string;
}

export interface DraftSet {
  sourceFacts: string[];
  hooks: string[];
  variations: DraftVariation[];
  selectionPrompt: string;
}

export interface FinalDraft {
  postText: string;
  copyBlock: string;
  followUpRevision: string;
  followUpImage: string;
  sourceLink?: string | undefined;
}

export interface ImageConcept {
  id: string;
  styleDirection: string;
  visualIdea: string;
  whyItWorks: string;
  basePrompt: string;
}

export interface FinalImagePrompt {
  promptText: string;
  copyBlock: string;
  confirmationQuestion: string;
}

export type ImageAssetStatus = "generated" | "warning" | "failed";

export interface ImageAssetVariant {
  id: string;
  label: string;
  filePath: string;
  metadataPath?: string | undefined;
  sourceUrl?: string | undefined;
  width?: number | undefined;
  height?: number | undefined;
  downloadKind?: string | undefined;
  tileOrder?: number | undefined;
}

export interface ImageAsset {
  id: string;
  toolId: ToolId;
  toolName: string;
  status: ImageAssetStatus;
  displayName?: string | undefined;
  files: string[];
  variants?: ImageAssetVariant[] | undefined;
  screenshotPath?: string | undefined;
  metadataPath?: string | undefined;
  notes?: string | undefined;
}

export interface ImageChoice {
  number: number;
  assetId: string;
  variantId?: string | undefined;
  filePath: string;
  displayName: string;
}

export interface AuthCheckpoint {
  toolId: ToolId;
  toolName: string;
  url: string;
  reason: string;
  requestedAt: string;
}

export type RunStage =
  | "created"
  | "awaiting_content_approval"
  | "blocked_on_source_access"
  | "awaiting_chat_approval"
  | "awaiting_draft_selection"
  | "awaiting_revision_or_image_mode"
  | "awaiting_image_concept_selection"
  | "awaiting_image_generation"
  | "awaiting_image_generation_confirmation"
  | "generating_images"
  | "awaiting_auth"
  | "awaiting_auth_confirmation"
  | "awaiting_image_selection"
  | "ready_for_linkedin"
  | "ready_to_post"
  | "failed"
  | "archived";

export interface RunEvent {
  at: string;
  stage: RunStage;
  message: string;
}

export interface RunRecord {
  id: string;
  schema_version: number;
  createdAt: string;
  updatedAt: string;
  stage: RunStage;
  workflowMode: WorkflowMode;
  input: PipelineInput;
  resolvedInput?: DirectPipelineInput | undefined;
  articleSource?: ArticleSource | undefined;
  draftSet?: DraftSet | undefined;
  finalDraft?: FinalDraft | undefined;
  imageConcepts?: ImageConcept[] | undefined;
  finalImagePrompt?: FinalImagePrompt | undefined;
  imageStyleChoice?: string | undefined;
  imageAssets: ImageAsset[];
  selectedImageAssetId?: string | undefined;
  selectedImageVariantId?: string | undefined;
  selectedImagePath?: string | undefined;
  pendingAuth?: AuthCheckpoint | undefined;
  activeToolId?: ToolId | undefined;
  activeToolName?: string | undefined;
  latestResponseIds: Partial<Record<"draftSet" | "finalDraft" | "imageConcepts" | "finalImagePrompt", string | undefined>>;
  notes: string[];
  events: RunEvent[];
}

export interface SelectChoice {
  hookIndex?: number | undefined;
  variationLabel?: DraftVariation["label"] | undefined;
  finalize: boolean;
}
