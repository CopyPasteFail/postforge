import type { RunRecord } from "./types.js";

export const summarizeNextAction = (run: RunRecord): string => {
  switch (run.stage) {
    case "awaiting_content_approval":
      return "Review the source material and submit approved post text and image prompt via submit_approved_copy.";
    case "awaiting_chat_approval":
      return "Review the source material and submit approved post text and image prompt via submit_approved_copy.";
    case "awaiting_draft_selection":
      return "Choose a draft with select --run <id> --value 2C.";
    case "blocked_on_source_access":
      return "Paste the exact article title and relevant article text as a draft input on a new run.";
    case "awaiting_revision_or_image_mode":
      return "Either revise the approved draft or move to image mode.";
    case "awaiting_image_concept_selection":
      return "Choose an image concept.";
    case "awaiting_image_generation":
      return "Call generate_image_candidates to start image generation.";
    case "awaiting_image_generation_confirmation":
      return "Call generate_image_candidates to start image generation.";
    case "generating_images":
      return `Image generation is in progress${run.activeToolName ? ` on ${run.activeToolName}` : ""}.`;
    case "awaiting_auth":
      return `Complete login for ${run.pendingAuth?.toolName ?? "the pending tool"} via ensure_auth, then retry generate_image_candidates.`;
    case "awaiting_auth_confirmation":
      return `Complete login for ${run.pendingAuth?.toolName ?? "the pending tool"} via ensure_auth, then retry.`;
    case "awaiting_image_selection":
      return "Choose an image with select_image_candidate.";
    case "ready_for_linkedin":
      return "Call prepare_linkedin_draft to fill the LinkedIn composer.";
    case "ready_to_post":
      return "LinkedIn is ready in the browser. Click Post manually on the website.";
    case "failed":
      return "Inspect the latest event for the failure reason.";
    case "archived":
      return "This run has been cancelled.";
    default:
      return "Run the next pipeline tool for this stage.";
  }
};
