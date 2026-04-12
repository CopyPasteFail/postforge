export type ToolId =
  | "chatgpt"
  | "gemini"
  | "ai-studio"
  | "flow"
  | "grok"
  | "copilot"
  | "linkedin";

export interface ImageToolConfig {
  id: Exclude<ToolId, "linkedin">;
  /** Browser profile directory to use. Defaults to id. Set to "google" to share one login across Gemini/AI Studio/Flow. */
  profileId?: string;
  name: string;
  url: string;
  setting: string;
  loginIndicators: {
    loggedInSelectors: string[];
    loggedOutSelectors: string[];
  };
  promptSelectors: string[];
  submitSelectors: string[];
  resultImageSelectors: string[];
  busySelectors: string[];
  notes: string;
}

export interface LinkedInConfig {
  id: "linkedin";
  name: string;
  url: string;
  composeUrl: string;
  loginIndicators: {
    loggedInSelectors: string[];
    loggedOutSelectors: string[];
  };
  startPostSelectors: string[];
  textAreaSelectors: string[];
  uploadSelectors: string[];
  postButtonSelectors: string[];
  dismissSelectors: string[];
  saveDraftSelectors: string[];
}

export const imageToolConfigs: ImageToolConfig[] = [
  {
    id: "chatgpt",
    name: "ChatGPT",
    url: "https://chatgpt.com/",
    setting: "DALL-E",
    loginIndicators: {
      loggedInSelectors: [
        "#prompt-textarea",
        "textarea[placeholder*='Message']",
      ],
      loggedOutSelectors: [
        "a[href*='login']",
        "button:has-text('Log in')",
        "button:has-text('Sign up')",
      ],
    },
    promptSelectors: [
      "#prompt-textarea",
      "textarea[placeholder*='Message']",
      "textarea",
    ],
    submitSelectors: [
      "button[data-testid='send-button']",
      "button[aria-label*='Send']",
      "button:has-text('Send')",
    ],
    resultImageSelectors: [
      "main img",
      "article img",
    ],
    busySelectors: [
      "[data-testid='stop-button']",
      "[aria-label*='Stop']",
    ],
    notes: "Relies on the site auto-routing image prompts to ChatGPT image generation.",
  },
  {
    id: "gemini",
    profileId: "google",
    name: "Gemini",
    url: "https://gemini.google.com/",
    setting: "Create Image",
    loginIndicators: {
      loggedInSelectors: [
        "a[aria-label*='Google Account']",
        "[aria-label*='Google Account']",
      ],
      loggedOutSelectors: [
        // Note: do NOT use a[href*='accounts.google.com'] — the logged-in account
        // avatar also links to accounts.google.com, which would cause false negatives.
        "button:has-text('Sign in')",
        "a:has-text('Sign in')",
      ],
    },
    promptSelectors: [
      "div.ql-editor[contenteditable='true'][role='textbox'][aria-label*='Gemini']",
      "div[contenteditable='true'][role='textbox'][data-placeholder*='Ask Gemini']",
      "input[placeholder*='Ask Gemini']",
      "input[aria-label*='Ask Gemini']",
      "textarea[placeholder*='Ask Gemini']",
      "textarea",
      "div[contenteditable='true']",
    ],
    submitSelectors: [
      "button[aria-label*='Send']",
      "button:has-text('Send')",
    ],
    resultImageSelectors: [
      "img",
    ],
    busySelectors: [
      "button[aria-label*='Stop']",
      "mat-progress-bar",
    ],
    notes: "May require selector tuning for Gemini's image-mode toggle.",
  },
  {
    id: "ai-studio",
    profileId: "google",
    name: "AI Studio",
    url: "https://aistudio.google.com/",
    setting: "nano banana",
    loginIndicators: {
      loggedInSelectors: [
        "button:has-text('Create with Flow')",
        "span:has-text('Create with Flow')",
        "textarea",
        "div[contenteditable='true']",
      ],
      loggedOutSelectors: [
        "button:has-text('Sign in')",
        "a[href*='accounts.google.com']",
      ],
    },
    promptSelectors: [
      "textarea[placeholder*='Start typing a prompt']",
      "textarea[placeholder*='use alt + enter to append']",
      "textarea[placeholder*='Start typing a prompt']",
      "textarea[aria-label*='prompt']",
      "div[contenteditable='true'][role='textbox'][aria-label*='prompt']",
      "div[contenteditable='true'][data-placeholder*='Start typing a prompt']",
      "div[contenteditable='true'][aria-placeholder*='Start typing a prompt']",
      "div[contenteditable='true'][placeholder*='Start typing a prompt']",
      "[role='textbox'][contenteditable='true']",
      "textarea",
      "div[contenteditable='true']",
    ],
    submitSelectors: [
      "button[aria-label*='Run']",
      "button:has-text('Run')",
      "button:has-text('Send')",
    ],
    resultImageSelectors: [
      "img",
      "canvas",
    ],
    busySelectors: [
      "button:has-text('Stop')",
      "mat-progress-bar",
    ],
    notes: "Model selection to nano banana should be treated as site-specific and may need follow-up hardening.",
  },
  {
    id: "flow",
    profileId: "google",
    name: "Flow",
    url: "https://labs.google/fx/tools/flow",
    setting: "nano banana 2, 2 images",
    loginIndicators: {
      loggedInSelectors: [
        "div[contenteditable='true']",
        "[role='textbox'][contenteditable='true']",
        "button:has-text('New project')",
        "button:has-text('Create')",
        "button:has-text('Refine')",
        "button:has-text('Compose')",
      ],
      loggedOutSelectors: [
        "button:has-text('Sign in')",
        "a[href*='accounts.google.com']",
      ],
    },
    promptSelectors: [
      "[role='textbox'][contenteditable='true']",
      "textarea:not(.g-recaptcha-response)",
      "textarea[placeholder*='Describe']",
      "textarea[placeholder*='Prompt']",
      "div[contenteditable='true']",
    ],
    submitSelectors: [
      "button:has-text('arrow_forwardCreate')",
      "button:has-text('Create')",
      "button[aria-label*='Generate']",
      "button:has-text('Generate')",
      "button:has-text('Run')",
    ],
    resultImageSelectors: [
      "img",
      "canvas",
    ],
    busySelectors: [
      "button:has-text('Stop')",
      "mat-progress-bar",
    ],
    notes: "Two-image output mode is adapter-specific and should be validated live after login.",
  },
  {
    id: "grok",
    name: "Grok",
    url: "https://grok.com/",
    setting: "Chat Mode",
    loginIndicators: {
      loggedInSelectors: [
        "textarea",
        "div[contenteditable='true']",
      ],
      loggedOutSelectors: [
        "button:has-text('Log in')",
        "button:has-text('Sign in')",
      ],
    },
    promptSelectors: [
      "textarea",
      "div[contenteditable='true']",
    ],
    submitSelectors: [
      "button[aria-label*='Send']",
      "button:has-text('Send')",
    ],
    resultImageSelectors: [
      "img",
    ],
    busySelectors: [
      "button:has-text('Stop')",
    ],
    notes: "Assumes image generation is available via the default chat workflow.",
  },
  {
    id: "copilot",
    name: "Copilot",
    url: "https://copilot.microsoft.com/",
    setting: "Standard",
    loginIndicators: {
      loggedInSelectors: [
        "button[aria-label='Account manager']",
        "[data-testid='user-profile-button']",
        "button:has-text('Sign out')",
        "[aria-label*='account' i]",
        "[aria-label*='profile' i]",
      ],
      loggedOutSelectors: [
        "button:has-text('Sign in')",
        "a[href*='login.live.com']",
        "a[href*='login.microsoftonline.com']",
        "button:has-text('Log in')",
        "a:has-text('Sign in')",
        "[aria-label='Sign in']",
      ],
    },
    promptSelectors: [
      "textarea[placeholder*='Message Copilot']",
      "textarea[aria-label*='Message Copilot']",
      "[aria-label*='Message Copilot']",
      "[role='textbox'][aria-label*='Message Copilot']",
      "textarea",
      "div[contenteditable='true']",
    ],
    submitSelectors: [
      "button[aria-label*='Send']",
      "button:has-text('Send')",
    ],
    resultImageSelectors: [
      "img",
    ],
    busySelectors: [
      "button:has-text('Stop')",
    ],
    notes: "Image routing may depend on the current Copilot experience and can require adapter tuning.",
  },
];

export const linkedInConfig: LinkedInConfig = {
  id: "linkedin",
  name: "LinkedIn",
  url: "https://www.linkedin.com/",
  composeUrl: "https://www.linkedin.com/feed/",
  loginIndicators: {
    loggedInSelectors: [
      // The compose trigger is a div[role=button] in the light DOM.
      "div[role='button']:has-text('Start a post')",
      // Nav links that only appear when logged in.
      "a[href*='/messaging/']",
      "a[href*='/notifications/']",
    ],
    loggedOutSelectors: [
      "a[href*='linkedin.com/login']",
      "button:has-text('Sign in')",
      "a:has-text('Sign in')",
    ],
  },
  startPostSelectors: [
    // LinkedIn 2026: the "Start a post" trigger is a <div role="button">
    // containing a <p> with text, inside obfuscated class containers.
    "div[role='button']:has-text('Start a post')",
  ],
  textAreaSelectors: [
    // LinkedIn 2026: the compose dialog lives inside an open Shadow DOM
    // at #interop-outlet.  Playwright pierces open shadow DOM by default
    // so these selectors work via page.locator().
    "div.ql-editor[contenteditable='true'][role='textbox']",
    "div[role='textbox'][aria-label='Text editor for creating content']",
    "div[role='textbox'][contenteditable='true']",
    "div.ql-editor[contenteditable='true']",
  ],
  uploadSelectors: [
    "input[type='file']",
  ],
  postButtonSelectors: [
    "button:has-text('Post')",
  ],
  dismissSelectors: [
    "button[aria-label='Dismiss']",
    "button[aria-label='Close']",
  ],
  saveDraftSelectors: [
    "button:has-text('Save as draft')",
  ],
};
