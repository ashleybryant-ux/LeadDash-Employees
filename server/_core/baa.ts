/**
 * LeadDash Marketing's business associate agreements with the AI providers,
 * as they stand. A practice's BAA is with LeadDash, so the providers are never
 * listed to the practice; this file decides which provider may carry client
 * information. Update it when an agreement is signed.
 */
export const BAA = {
  /** Writing, thinking and transcription: every employee's drafts and replies, the EHR work, meeting notes. */
  assemblyai: "signed",
  /** Pictures and voices. */
  openai: "signed",
  /** Web search and reading photos and scanned PDFs. Requested through Anthropic sales, not countersigned yet. */
  anthropic: "requested",
  elevenlabs: "none",
  fal: "none",
} as const;

export type Provider = keyof typeof BAA;

/** Whether client information may be sent to this provider. */
export function carriesClientInfo(p: Provider) {
  return BAA[p] === "signed";
}
