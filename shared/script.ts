/**
 * Reading a script she wrote (2026-10-16). Elena used to rewrite an uploaded script into
 * one short sentence per shot and squeeze it into 30 seconds. Now a script is kept word
 * for word: every line, in order, by the person who says it. A long line runs over two
 * or three shots of the same speaker instead of being cut, and the length comes from
 * the script itself.
 *
 * Two shapes are read:
 * - "MAYA: I need this done today." (any name, any case, a colon after it)
 * - Screenplay: the name on its own line in capitals, the words on the lines under it.
 * Stage directions in (parentheses) or [brackets] are not spoken; they stay with the
 * line as a note on what we see.
 */

export type ScriptLine = { who: string; text: string; note: string };

/** Words a person says in a second, about: a natural, unhurried pace. */
export const WORDS_PER_SECOND = 2.6;
/** The most words one shot carries, so the line fits the clip (a shot is 7 seconds at most). */
export const MAX_SHOT_WORDS = 16;

// Headings and directions that look like "NAME:" but are not a person speaking.
const NOT_A_SPEAKER = /^(int|ext|int\/ext|scene|shot|cut to|fade in|fade out|fade to|dissolve to|title|titles|note|notes|music|sfx|sound|camera|angle|setting|location|time|act|part|logline|summary|cast|characters?|v\.?o\.?|o\.?s\.?|transition|super|caption|on screen|onscreen|text|b-roll|broll|visual|visuals|audio|direction|directions|action|tone|style|look|length|format|goal|audience|hook|cta|call to action|mood|genre|ratio|voice|intro|outro|opening|ending|end|props|wardrobe|platform|duration|theme|message|brand|logo|plot|premise|setup|beat|purpose|objective|idea|concept|vibe|pace|lighting|shape)$/i;

/** "Maya: a therapist in her 40s, braids" describes someone; it isn't her talking. */
const describes = (text: string) => /^(a|an)\s/i.test(text) && !/\b(I|I'm|I've|I'll|you|you're|we|we're|my|our|me|us)\b|[?!]/.test(text);

const cleanName = (s: string) =>
  s
    .replace(/\((?:v\.?o\.?|o\.?s\.?|o\.?c\.?|cont'?d|continuing|on phone|over phone|off|into phone)\)/gi, "")
    .replace(/[*_#>]/g, "")
    .replace(/\s+/g, " ")
    .trim();

const asName = (s: string) => {
  const n = cleanName(s);
  if (!n || n.length > 40 || NOT_A_SPEAKER.test(n)) return "";
  if (!/^[A-Za-z\u00C0-\u024F][A-Za-z\u00C0-\u024F.' -]*$/.test(n)) return "";
  if (n.split(" ").length > 4) return "";
  // "Dr. Cohen", "MAYA", "Harper", "Front desk": shown the way it's usually written.
  return n === n.toUpperCase() && n.length > 2 ? n.toLowerCase().replace(/(^|[\s.'-])([a-z\u00E0-\u024F])/g, (_m, a: string, b: string) => a + b.toUpperCase()) : n;
};

/** The spoken words and the directions in a line, apart. */
function splitDirections(s: string) {
  const notes: string[] = [];
  const text = s
    .replace(/\(([^)]*)\)|\[([^\]]*)\]/g, (_m, a?: string, b?: string) => {
      const t = (a ?? b ?? "").trim();
      if (t) notes.push(t);
      return " ";
    })
    .replace(/[*_]/g, "")
    .replace(/\s+/g, " ")
    .trim()
    .replace(/^["“](.*)["”]$/, "$1");
  return { text, note: notes.join("; ") };
}

/**
 * The lines of a script, or null when the text is a description rather than a script.
 * It counts as a script when at least two lines are spoken by a named person.
 */
export function readScript(raw: string): ScriptLine[] | null {
  const rows = raw.replace(/\r/g, "").split("\n");
  const out: ScriptLine[] = [];
  let pending: { who: string; parts: string[]; notes: string[] } | null = null;
  const flush = () => {
    if (!pending) return;
    const joined = splitDirections(pending.parts.join(" "));
    const note = [...pending.notes, joined.note].filter(Boolean).join("; ");
    if (joined.text) out.push({ who: pending.who, text: joined.text, note });
    pending = null;
  };
  for (const row of rows) {
    const line = row.trim();
    if (!line) {
      flush();
      continue;
    }
    // "NAME: words" (also "**Name:** words" from a document).
    const colon = line.match(/^\**([^:*]{1,48}?)\**\s*:\s*\**\s*(.*)$/);
    const who = colon ? asName(colon[1]) : "";
    if (who && !/^\d/.test(colon![2]) && !describes(colon![2])) {
      flush();
      pending = { who, parts: colon![2] ? [colon![2]] : [], notes: [] };
      continue;
    }
    // A heading ("Setting: a modern office") or someone described ends the line before it.
    if (colon && (who || NOT_A_SPEAKER.test(cleanName(colon[1])))) {
      flush();
      continue;
    }
    // Screenplay: a name in capitals on its own line.
    if (/^[A-Z][A-Z0-9 .'-]{0,38}(\s*\([^)]*\))?$/.test(line) && !/^(INT|EXT)[. ]/.test(line)) {
      const n = asName(line);
      if (n) {
        flush();
        pending = { who: n, parts: [], notes: [] };
        continue;
      }
    }
    if (pending) {
      // A parenthetical on its own line under the name is a direction for this line.
      const only = line.match(/^\(([^)]*)\)$/);
      if (only) pending.notes.push(only[1].trim());
      else pending.parts.push(line);
    }
  }
  flush();
  return out.length >= 2 ? out : null;
}

export const wordsIn = (s: string) => s.split(/\s+/).filter(Boolean).length;

/** How long the script runs when it's said at a natural pace, with a beat between lines. */
export function scriptSeconds(lines: ScriptLine[]) {
  return Math.round(lines.reduce((t, l) => t + wordsIn(l.text) / WORDS_PER_SECOND + 0.6, 0));
}

/** Seconds for a shot that carries these words: long enough to say them, 3 to 7. */
export const secondsFor = (text: string) => Math.max(3, Math.min(7, Math.ceil(wordsIn(text) / WORDS_PER_SECOND + 0.8)));

/**
 * One line cut into parts for shots in a row, never changing a word: at the ends of
 * sentences first, then at commas, then between words. Each part is at most MAX_SHOT_WORDS,
 * so a line may come back in more parts than asked for.
 */
export function splitLine(text: string, parts = 1): string[] {
  const words = wordsIn(text);
  const want = Math.max(parts, Math.ceil(words / MAX_SHOT_WORDS), 1);
  if (want === 1) return [text.trim()];
  // Pieces that can be joined back: sentences, then clauses, then words.
  let pieces = text.match(/[^.!?]+[.!?]+["'”)\]]*\s*|[^.!?]+$/g)?.map((s) => s.trim()).filter(Boolean) ?? [text];
  const breakUp = (list: string[], re: RegExp) => list.flatMap((p) => (wordsIn(p) > MAX_SHOT_WORDS ? p.split(re).map((s) => s.trim()).filter(Boolean) : [p]));
  pieces = breakUp(pieces, /(?<=[,;:—])\s+/);
  pieces = pieces.flatMap((p) => {
    const w = p.split(/\s+/);
    if (w.length <= MAX_SHOT_WORDS) return [p];
    const n = Math.ceil(w.length / MAX_SHOT_WORDS);
    const size = Math.ceil(w.length / n);
    return Array.from({ length: n }, (_, i) => w.slice(i * size, (i + 1) * size).join(" "));
  });
  // Join pieces into the number of parts wanted, evenly by words, never over the most a shot carries.
  const total = pieces.reduce((t, p) => t + wordsIn(p), 0);
  const out: string[] = [];
  let cur: string[] = [];
  let curWords = 0;
  for (let i = 0; i < pieces.length; i++) {
    const w = wordsIn(pieces[i]);
    const left = want - out.length;
    const target = (total - out.reduce((t, p) => t + wordsIn(p), 0)) / Math.max(1, left);
    if (cur.length && (curWords + w > MAX_SHOT_WORDS || (curWords >= target && left > 1 && pieces.length - i >= left - 1))) {
      out.push(cur.join(" "));
      cur = [];
      curWords = 0;
    }
    cur.push(pieces[i]);
    curWords += w;
  }
  if (cur.length) out.push(cur.join(" "));
  return out;
}
