// Every test file gets its own empty in-memory database and no real AI keys.
process.env.NODE_ENV = "test";
process.env.DATABASE_PATH = ":memory:";
process.env.UPLOADS_DIR = "/tmp/leaddash-employees-test-uploads";
process.env.ADMIN_EMAILS = "staff@leaddash.io";
process.env.SECRETS_KEY = "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";
process.env.ASSEMBLYAI_API_KEY = "";
process.env.ANTHROPIC_API_KEY = "";
process.env.OPENAI_API_KEY = "";
