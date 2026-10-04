/**
 * Emails that read like the owner typed them herself. The rules go into the
 * prompt, and findTells() catches the phrases that still give a draft away as AI,
 * so the draft gets one more pass before anyone sees it.
 */

export const HUMAN_EMAIL = `How the owner writes email. It has to read like she typed it herself in two minutes, one practice owner to another:
- Short, plain and a little informal. Contractions are fine. Every line is a full sentence: never fragments like "No per-clinician pricing." or "Built by a therapist."
- Open with why you're writing to this person, said plainly ("I saw you're hiring a sixth therapist."). Never tell them what their problem is or guess at their costs, and never "which means".
- Name one or two things that fit what you found, never a list of every feature. Never list four or more things in one sentence.
- One ask, worded the way a person asks: "Want me to show you how it works?" or "Open to a call next week?"
- Follow-ups: refer back to the first email in a few words, add one specific new fact, and stop. The last email is a short, friendly close ("Should I close this out for now?").
- Never compare to a named competitor or say what another product lacks unless the Brain states that exact comparison.
- Never these words or phrases: one thing worth knowing, that matters, which means, I noticed, I came across, I hope this finds you, quick question, just wanted to, reaching out, touch base, circle back, worth a look, a group your size, happy to connect, seamless, streamline, all-in-one, game changer, elevate, empower, unlock, leverage, solution, robust, cutting-edge, hassle.
- A subject line is what a person would type: lower-key and specific ("your hiring post", "fax and billing in one place"), never a slogan like "One platform for [practice]".`;

const TELLS: [RegExp, string][] = [
  [/one thing worth knowing/i, "One thing worth knowing"],
  [/\bthat matters\b/i, "that matters"],
  [/\bwhich means\b/i, "which means"],
  [/\bI noticed\b/i, "I noticed"],
  [/\bcame across\b/i, "came across"],
  [/hope (this|you) (finds|find|are)/i, "hope this finds you"],
  [/\bquick question\b/i, "quick question"],
  [/\bjust wanted to\b/i, "just wanted to"],
  [/\breaching out\b/i, "reaching out"],
  [/\btouch base\b/i, "touch base"],
  [/\bcircle back\b/i, "circle back"],
  [/\bworth a (look|conversation|chat)\b/i, "worth a look"],
  [/\b(group|practice|team) (of )?your size\b/i, "a group your size"],
  [/\bhappy to connect\b/i, "happy to connect"],
  [/\bseamless(ly)?\b/i, "seamless"],
  [/\bstreamlin/i, "streamline"],
  [/\ball-in-one\b/i, "all-in-one"],
  [/\bgame[- ]?changer\b/i, "game changer"],
  [/\belevat/i, "elevate"],
  [/\bempower/i, "empower"],
  [/\bunlock/i, "unlock"],
  [/\bleverag/i, "leverage"],
  [/\bsolutions?\b/i, "solution"],
  [/\brobust\b/i, "robust"],
  [/\bcutting[- ]edge\b/i, "cutting-edge"],
  [/\bsolid team\b/i, "solid team"],
  [/[—–]/, "a dash"],
  [/^one platform for\b/im, "a slogan subject line"],
  // Four or more things strung together with commas.
  [/(?:\b[\w-]+(?: [\w-]+)?, ){3,}(?:and |or )?[\w-]+/i, "a long list of features"],
  // Short fragments the model loves: "No per-clinician pricing." "Built by a licensed therapist..."
  [/(?:^|[.!?]\s+)(?:No|Built|Designed|Made) [^.!?]{0,60}(?:pricing|fees|contracts|therapist|clinicians?|practices?)[^.!?]{0,60}\./, "a sentence fragment"],
];

/** The phrases in a draft that give it away as AI, without repeats. */
export function findTells(...texts: string[]) {
  const found = new Set<string>();
  for (const t of texts) for (const [re, label] of TELLS) if (re.test(t)) found.add(label);
  return Array.from(found);
}
