/**
 * The AI and software providers behind LeadDash Employees are trade secrets: a
 * workspace is told only that LeadDash has a BAA with every subprocessor that
 * handles client information, never who they are. Anything the app shows a
 * workspace (an error, a voice problem, what an employee says) goes through
 * hideProviders, which swaps a provider's name, its links and its server key
 * names for a plain description. The full message stays in the server logs.
 */
const SWAPS: [RegExp, string][] = [
  // The meeting bot's name looks like its web address, so it goes before the links.
  [/\bRecall\.ai\b(?!\/)(['’]s)?/g, "the meeting bot"],
  // Links and server keys next, so their words don't get half-replaced.
  [/\s*(at|on|in)\s+(https?:\/\/)?([a-z0-9-]+\.)*(elevenlabs\.io|openai\.com|anthropic\.com|assemblyai\.com|recall\.ai|fal\.ai|fal\.run)(\/[^\s,)]*[^\s,).])?/gi, ""],
  [/(https?:\/\/)?([a-z0-9-]+\.)*(elevenlabs\.io|openai\.com|anthropic\.com|assemblyai\.com|recall\.ai|fal\.ai|fal\.run)(\/[^\s,)]*[^\s,).])?/gi, "the provider's site"],
  [/\b(ELEVENLABS|OPENAI|ANTHROPIC|ASSEMBLYAI|RECALL|FAL)_[A-Z_]*\b/g, "a server key"],
  [/\bElevenLabs(['’]s)?( Music| sound effects)?\b/gi, "the voice service"],
  [/\bAssemblyAI(['’]s)?\b/gi, "the transcription service"],
  [/\bRecall(\.ai)?(['’]s)? ?(meeting bot)?\b(?=[\s:,.)]|$)/g, "the meeting bot"],
  [/\bfal(\.ai)?(['’]s)?\b(?=[\s:,.)]|$)/g, "the video service"],
  [/\b(OpenAI|Anthropic)(['’]s)?\b/g, "the AI service"],
  [/\b(gpt-[\w.-]+|claude-(sonnet|opus|haiku)[\w.-]*|Claude (Sonnet|Opus|Haiku)[\w. ]*?\d[\w.]*)\b/gi, "the AI model"],
];

export function hideProviders(text: string): string {
  if (!text) return text;
  let out = text;
  for (const [re, to] of SWAPS) out = out.replace(re, to);
  return out.replace(/\bthe (voice|AI|transcription|video) service voices\b/g, "the $1 service").replace(/[ \t]{2,}/g, " ");
}
