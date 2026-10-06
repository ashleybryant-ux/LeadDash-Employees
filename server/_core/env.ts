/**
 * Every setting the server reads, in one place. Values come from .env on the
 * server (never committed). See .env.example for the full list.
 */
const list = (value: string | undefined) =>
  (value || "")
    .split(",")
    .map((v) => v.trim().toLowerCase())
    .filter(Boolean);

export const ENV = {
  isProduction: process.env.NODE_ENV === "production",
  port: parseInt(process.env.PORT || "4100", 10),
  /** Public address of the app, used in sign-in emails. */
  appUrl: (process.env.APP_URL || "http://localhost:4100").replace(/\/+$/, ""),

  // Storage
  databasePath: process.env.DATABASE_PATH || "./data/employees.db",
  uploadsDir: process.env.UPLOADS_DIR || "./data/uploads",

  // Sign-in
  /** Emails that are LeadDash staff (support access to every workspace). */
  adminEmails: list(process.env.ADMIN_EMAILS),
  sessionDays: parseInt(process.env.SESSION_DAYS || "14", 10),

  // Email (Amazon SES, same account as LeadDash EHR)
  sesRegion: process.env.SES_REGION || "us-east-1",
  emailFrom: process.env.EMAIL_FROM || "LeadDash Employees <noreply@leaddash.io>",
  emailReplyTo: process.env.EMAIL_REPLY_TO || "info@leaddash.io",

  // AI
  /** AssemblyAI LLM Gateway key (same key DashNotes uses). Used for all writing. */
  assemblyAiKey: process.env.ASSEMBLYAI_API_KEY || "",
  llmGatewayUrl: process.env.LLM_GATEWAY_URL || "https://llm-gateway.assemblyai.com/v1/chat/completions",
  llmModel: process.env.LLM_MODEL || "claude-sonnet-4-6",
  /**
   * Who runs web searches (grants, speaking events, video trends, license
   * checks): "anthropic" (the default: the Anthropic key, its web search tool)
   * or "openai" (the OpenAI key, Responses API web search tool). No search
   * carries client information on either; OpenAI's web search sits outside
   * its BAA, Anthropic's is HIPAA eligible once a BAA is in place.
   */
  searchProvider: (process.env.SEARCH_PROVIDER || "anthropic").toLowerCase() === "openai" ? "openai" : "anthropic",
  openAiSearchModel: process.env.OPENAI_SEARCH_MODEL || "gpt-6.1-sol",
  /** Anthropic key: web search when SEARCH_PROVIDER=anthropic, and reading scanned PDFs and photos. */
  anthropicKey: process.env.ANTHROPIC_API_KEY || "",
  /** Needed only for a personal key (sk-ant-usr-) that is not scoped to one workspace. Looks like wrkspc_... */
  anthropicWorkspaceId: process.env.ANTHROPIC_WORKSPACE_ID || "",
  anthropicModel: process.env.ANTHROPIC_MODEL || "claude-sonnet-5-5",
  searchMaxUses: parseInt(process.env.SEARCH_MAX_USES || "6", 10),
  /** Serper.dev key: Google results for opportunity searches, alongside Anthropic's web search. */
  serperKey: process.env.SERPER_API_KEY || "",
  /** Most one "find" request may spend on web searches, in dollars, across its rounds. */
  searchBudgetUsd: parseFloat(process.env.SEARCH_BUDGET_USD || "2"),
  /** ElevenLabs key: when set, huddle voices come from ElevenLabs instead of OpenAI. */
  elevenLabsKey: process.env.ELEVENLABS_API_KEY || "",
  /** fal.ai: pay-per-second video models (Kling talking avatar) for Elena. */
  falKey: process.env.FAL_KEY || "",
  /** GitHub fine-grained token for Kai: issues, pull requests and contents on the owner's repos. */
  githubToken: process.env.GITHUB_TOKEN || "",
  elevenLabsModel: process.env.ELEVENLABS_MODEL || "eleven_flash_v2_5",
  /** OpenAI key: images, voices when ElevenLabs is not set, and web search when SEARCH_PROVIDER=openai. */
  openAiKey: process.env.OPENAI_API_KEY || "",
  imageModel: process.env.OPENAI_IMAGE_MODEL || "gpt-image-2",

  // Business associate agreements, for the Workspace page of a healthcare practice.
  /** Providers with a signed BAA, e.g. "assemblyai,openai". Anthropic joins the list when its BAA is countersigned. */
  baaSigned: list(process.env.BAA_SIGNED),
  /** Providers with a BAA requested but not yet signed, e.g. "anthropic". */
  baaRequested: list(process.env.BAA_REQUESTED),

  // Push notifications (Web Push). Generate once with: npx web-push generate-vapid-keys
  vapidPublicKey: process.env.VAPID_PUBLIC_KEY || "",
  vapidPrivateKey: process.env.VAPID_PRIVATE_KEY || "",
  vapidSubject: process.env.VAPID_SUBJECT || "mailto:info@leaddash.io",

  // Hiring checks
  /** SAM.gov public API key (free, from a SAM.gov account). Used for the exclusion check. */
  samApiKey: process.env.SAM_API_KEY || "",

  // Secrets at rest
  /** 32-byte key, base64 or hex. Encrypts connection secrets in the database. */
  secretsKey: process.env.SECRETS_KEY || "",
};
