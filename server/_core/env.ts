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
  /** Anthropic key, used only for employees that search the web (grants, speaking, video trends). */
  anthropicKey: process.env.ANTHROPIC_API_KEY || "",
  /** Needed only for a personal key (sk-ant-usr-) that is not scoped to one workspace. Looks like wrkspc_... */
  anthropicWorkspaceId: process.env.ANTHROPIC_WORKSPACE_ID || "",
  anthropicModel: process.env.ANTHROPIC_MODEL || "claude-sonnet-5-5",
  searchMaxUses: parseInt(process.env.SEARCH_MAX_USES || "6", 10),
  /** OpenAI key, used only for social and blog images. */
  openAiKey: process.env.OPENAI_API_KEY || "",
  imageModel: process.env.OPENAI_IMAGE_MODEL || "gpt-image-2",

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
