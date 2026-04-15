---
name: linkedin-post
description: "Use when the user wants to write, create, draft, or publish a LinkedIn post, turn an article or idea into a LinkedIn post, generate images, or run the full post pipeline."
---

# LinkedIn Post Pipeline

Complete end-to-end workflow: discover topic -> write post -> confirm text -> generate images -> user picks best -> prepare LinkedIn draft.

This skill owns all reasoning (writing, prompting, deciding). The `linkedin-post-agent` MCP server owns all execution (browser automation, persistent auth, image capture, LinkedIn composer filling).

**Hard rule: the server never posts. Only the user clicks Post.**

---

## Phase 0: News Discovery (optional)

Enter this phase when the user asks to find a topic, run a news scout, or says something like "find me something to post about" without providing a specific link or idea.

**Skip this phase entirely** if the user already provides a link, draft text, or specific idea.

### Discovery Flow

**Step 1: Fetch the scout prompt**
Read the MCP resource `linkedin://prompts/news-scout` from the `linkedin-post-agent` server. This returns the full news scout system prompt with ranking criteria, source priorities, and output format.

**Step 2: Execute the scout**
Follow the instructions in the returned prompt exactly. Use web search and web fetch capabilities to scan sources. The prompt specifies:
- Date ranges based on trigger type (weekly/daily/breaking)
- Source priority (official blogs, GitHub releases, credible AI news sites)
- Signal filtering criteria
- Ranking score (1-10) based on impact, reach, novelty
- Brief format for each item

If the user does not specify a trigger type, default to "Run Daily Update" (last 24 hours).

**Step 3: Present candidates**
Show the ranked results to the user using the exact brief format from the scout prompt. Ask: "Which story do you want to turn into a LinkedIn post? Pick a number, or give me a different link/idea."

**Step 4: Transition to Phase 1**
Once the user picks a story, take that story's link/title as the input and proceed to Phase 1.

---

## Phase 1: Post Writing

### Core Rules
- Output must be paste-ready, human, grammatically clean, and natural.
- No em dashes.
- No AI-sounding phrasing, fluff, or motivational tone.
- Do not invent facts.
- If a link is inaccessible or only partially accessible (paywall, snippet-only, login, region block), do not infer anything and do not use snippets, prior knowledge, or other sources unless explicitly asked.
- In that case, ask for: 1) exact article title 2) relevant article text
- Use this exact fallback line: "I can't access enough of that link to use it reliably. Please paste the exact article title and the relevant article text, and I'll draft from that only."

### Inputs
1. If a draft is pasted: polish it for publication, preserve voice, fix grammar, and remove AI-ish phrasing.
2. If an idea or link is pasted: extract concrete points, then write the post.

### Post Blueprint
Write the post as plain prose in this exact flow:
1. A one-line hook
2. 1 to 2 short first-person lines (micro memory), specific and human
3. One sharp practical insight sentence
4. 1 to 2 short article-anchored paragraphs that keep the most specific source details and metrics visible, then explain what they enable and why that matters in practice
5. One short closing line with a takeaway, implication, or grounded observation

**Blueprint Rendering Rules:**
- This structure is internal. Never print section labels or headings of any kind.
- Forbidden labels include: "Hook:", "Insight:", "Practical insight:", "Takeaway:", "Lesson:", "Observation:", "CTA:", "Closing:", or similar.
- Every line must read like natural prose.

### Hook Rules
- Must be one line.
- Must not end with a period.
- May end with nothing, ? or !

### Micro Memory Rules
- Must be first-person (I/we), brief, and grounded.
- Do not default to "I remember".
- Vary naturally: observation, contrast, frustration, realization, or shared experience.
- When generating 5 variations, vary the opening pattern across all 5.

### Writing Style and Formatting
- Short lines, white space, easy to skim.
- Use concrete verbs and specific nouns.
- Avoid corporate buzzwords: leverage, unlock, robust, seamless, game-changer, in today's world.
- Length should fit content: technical/architectural/systems topics can be longer; opinion/observation/narrative should stay tighter.
- Longer posts must still be skimmable.
- Never be long without a reason.
- Do not end paragraphs with periods.

### Closing Line Rules
- Do not force a question.
- Prefer a sharp takeaway, practical implication, or grounded observation.
- A discussion invite is allowed only if natural and specific.
- Avoid generic CTAs like "What do you think?" or "Thoughts?"
- Do not end all variations with questions.

### Hashtags (final draft only)
- Add up to 7 hashtags.
- Hashtagged keywords must already appear in the text.
- Embed hashtags naturally in sentences, not dumped at the end.
- Apply hashtags only in the final draft, never in draft variations.
- Hashtags may be single word (#AI) or multi-word camelCase/snake_case (#physicalAI or #physical_AI).
- No spaces inside hashtags.
- Prefer meaningful technical or conceptual terms.
- Never hashtag the same keyword more than once.

**Hashtag Placement Logic:** For each keyword, apply one hashtag only in this order:
1. First post-hook occurrence, if the keyword appears after the hook
2. Otherwise first occurrence in the hook
Match whole words, case-insensitive. Preserve original text casing.

---

## Turn 1: Draft Selection

**Before drafting:** call `start_run` with the user's input (link, draft, or idea) to create a pipeline run and obtain a `run_id`. Carry this `run_id` through all subsequent phases — do NOT call `start_run` again later. If `start_run` returns an existing run for the same source, use that `run_id`.

If input includes an accessible link:
1. **Source facts** - Extract 3 to 6 concrete facts, names, or claims from that exact link only.
2. **Hooks** - Generate 10 hook options, numbered 1 to 10, one line each, following Hook Rules.
3. **Text variations** - Generate 5 complete post bodies labeled A, B, C, D, E. Each starts with [HOOK GOES HERE]. Follow the Post Blueprint. No hashtags. Vary endings across bodies. Article anchor must include at least one specific number, metric, or named entity when available.
4. **Selection prompt** - Ask the user to choose with a combo like "2C". If only number: keep that hook, choose best variation. If only letter: use best hook, keep that variation. If "finalize": choose the strongest hook and variation.

If link is inaccessible, use the exact fallback line and stop. The `run_id` from `start_run` can still be reused if the user later pastes article text — call `submit_approved_copy` on it once content is approved.

---

## Turn 2: Final Draft + Revision Loop

- Build the final post from the selected hook and variation.
- Convert the selected hook into Unicode Mathematical Sans Bold.
- Apply hashtag logic.
- If input was a link, append: `Source: <exact original link>`
- Output the post inside a single plain fenced markdown block with no language tag.

**After any final or revised draft, always ask these two follow-ups exactly:**
1. "Want to revise the draft? You can reply with one word like 'shorter', 'punchier', or 'clearer'."
2. "Want to move on to image generation? Reply 'image' or choose a comic style: Rick and Morty, Dilbert, The Jetsons, The Simpsons, South Park, Garfield, Futurama, X-Men, The Adventures of Tintin. You can also name another satire comic."

**Revision Behavior:** Revise only the most recent draft. Do not regenerate hooks or variations. Preserve structure and intent. Output revised draft in a copyable block. Repeat the two follow-up questions.

---

## Phase 2: Image Generation (via MCP)

Enter image mode only if the user explicitly replies "image" or gives a comic style name.

### Comic Style Lock
If the user selects a comic style:
- Acknowledge briefly.
- Lock that style for the entire image stage.
- All concepts and prompts must strictly use that comic's visual style, characters, settings, and tropes.
- Every concept must include unmistakable elements from that comic universe.
- When the selected comic is a known franchise, include canon characters, named settings, signature props, and recognizable world details where appropriate.
- Use that comic's typical humor, composition, and world logic so the scene feels native to that universe.
- Do not mix styles or add external characters.
- Match that comic's typical humor and composition.

### Image Mode Flow

**Step 1: Concept options**
Suggest 3 to 5 image concepts. Each must include: style direction, visual idea, why it works for LinkedIn, base prompt.
Each concept should feel unmistakably native to the selected comic universe, not just compatible with its visual style.

**Step 2: User selection**
Ask the user to choose one concept (e.g., "2" or "B").

**Step 3: Detailed prompt regeneration**
Regenerate only the selected concept into one super-detailed final prompt. Include:
- Art style and visual language
- Characters: who, appearance, posture, expression
- Setting and background details
- Action / interaction
- Mood and emotional tone
- Camera framing and perspective
- Lighting and color palette
- Minimal readable on-screen text, if any
- Carry forward the franchise-specific elements from the selected concept into the final prompt.
- Make the universe cues explicit enough that two people would picture the same franchise-specific scene.

Output inside a single plain fenced markdown block with no language tag.

**Step 4: Submit approved copy and hand off to the server**
When the user confirms the prompt, use the MCP tools to hand off to the browser automation server:

1. Use the `run_id` obtained from `start_run` at Turn 1 (Phase 1 entry). Do NOT call `start_run` again here — calling it a second time with a URL re-fetches the article and may fail (HTTP 403, paywall, etc.) even if the article was accessible earlier. If you don't have a `run_id` yet (e.g. this is an idea-only flow with no prior `start_run`), call `start_run` now with `input_kind: "idea"` and a brief topic description as `input_text`.

2. Call `submit_approved_copy` with:
   - `run_id` from step 1
   - `post_text`: the finalized LinkedIn post text (with hashtags, bold hook, source link)
   - `image_prompt`: the super-detailed image prompt from step 3

**Step 5: Generate images via MCP**
3. Call `generate_image_candidates` with the `run_id`.
   - This is a long-running operation. The MCP server opens Playwright browsers, navigates to each enabled AI tool (ChatGPT, Gemini, AI Studio, Flow, Grok, Copilot), pastes the prompt, waits for generation, and captures the results.
   - The response contains a `candidates` array with numbered entries, each showing `tool_id`, `tool_name`, `status`, and `file_path`.
   - If the response includes `auth_required`: the server has already opened the browser for that tool. Tell the user **exactly**: "[ToolName] needs you to log in. A browser window has been opened — please log in there, then tell me when you're done." Use the `auth_required.next_step` field verbatim if present. After the user confirms, call `ensure_auth` with the `tool_id` to verify, then call `generate_image_candidates` again to resume.
   - If `generate_image_candidates` times out (120s), the run continues in the background. Call `get_run` to check progress. When the user says "continue", "resume", or "keep going", call `generate_image_candidates` again — it automatically skips tools that already produced results and picks up from where it left off.
   - Only call `finalize_candidates` if the user explicitly says they want to **skip** or **stop** waiting for remaining tools. Never call it to resume.

4. Present the candidates to the user. For each candidate, show: number, tool name, status.
   - If a `review_page_path` is returned, tell the user to open that file to compare images visually — images cannot be rendered inline in this chat.
   - If no `review_page_path`, tell the user the file paths so they can open the images directly.
   - Ask: "Which image do you want to use? Pick a number."

**Step 6: Select the image**
5. Call `select_image_candidate` with the `run_id` and the user's chosen `candidate_number`.

---

## Phase 3: Prepare LinkedIn Draft (via MCP)

After image selection:

1. Call `prepare_linkedin_draft` with the `run_id`.
   - The MCP server opens LinkedIn in a persistent Playwright browser, fills the composer with the approved post text, saves as draft, and opens the image folder.
   - The server never clicks Post.

2. Tell the user: "LinkedIn draft is ready. The composer has been filled with your post text and the image folder is open. Review the draft in your browser and click Post when ready."

---

## Authentication Handling

If any MCP tool call fails with an auth error or returns `auth_required`:
1. **Immediately tell the user** which tool needs login. Do not silently skip or proceed. Use the `next_step` field from `auth_required` verbatim if present, otherwise say: "[ToolName] needs you to log in. A browser window has been opened — please log in there, then tell me when you're done."
2. **To log in**: `generate_image_candidates` already opens the browser when auth is needed. Wait for the user to confirm they've logged in.
   - After the user says "done" / "logged in" / "I'm in": Call `ensure_auth` with the `tool_id` to verify. If `authenticated: true`, call `generate_image_candidates` again to resume.
   - If `ensure_auth` returns `awaiting_login` again, the browser window is still open — ask the user to complete login and confirm again.
3. **To skip**: If the user says "skip", "move on", "next tool", or doesn't want to log in — call `skip_tool` with the `run_id`. This marks the blocked tool as skipped and resets the stage. Then call `generate_image_candidates` to continue with the remaining tools.

## CAPTCHA / Anti-Bot Handling

If `auth_required` contains "CAPTCHA" or "human verification" in `reason` or `next_step`:
1. **Immediately tell the user**: "[ToolName] is showing a human verification challenge. The browser window is still open — please complete the CAPTCHA and tell me when you're done."
2. The browser window is **already open** (not closed). The user must complete the challenge there.
3. After the user confirms ("done", "completed"), call `generate_image_candidates` again to resume. The tool will retry from scratch.
4. If the user wants to skip, use `skip_tool` as with auth.

**Critical**: never attempt to solve or bypass CAPTCHAs. Always ask the user to complete them manually.

---

## Diagnostics

If anything seems broken (tools not responding, browsers not opening, etc.), call the `doctor` MCP tool. It checks:
- Node version
- Playwright installation
- Chrome availability
- Data directory writability
- Auth profiles per tool
- Enabled tools configuration

Report the results to the user.
