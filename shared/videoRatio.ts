/** The shape a video is filmed in. Scenes can be any of these; dramas and campaigns are filmed vertical. */
export type Ratio = "9:16" | "16:9" | "1:1";

/**
 * The shape a brief asks for in its own words (2026-10-15): "16:9", "widescreen", "landscape",
 * "horizontal video", "for YouTube" or "for the website" is wide; "9:16", "vertical video",
 * "for Reels", "for TikTok" or "for Stories" is vertical; "1:1" or "square video" is square. Null when it doesn't say.
 * Said in the brief, it wins over the choice on the form.
 */
export function ratioFromText(text: string): Ratio | null {
  const t = text.toLowerCase();
  const hits: [number, Ratio][] = [];
  const at = (re: RegExp, r: Ratio) => {
    const m = re.exec(t);
    if (m) hits.push([m.index, r]);
  };
  // Only words about the video's shape count, so "client stories", "Times Square" or "a wide shot" in the story never do.
  const fmt = "(?:video|format|version|frame|orientation|cut|trailer)";
  at(new RegExp(`\\b16\\s*[:x×]\\s*9\\b|\\bwide\\s*-?\\s*screen\\b|\\b(?:landscape|horizontal) ${fmt}\\b|\\b(?:in|as) (?:landscape|horizontal)\\b|\\bfor (?:youtube|the website|our website|my website|the site|a laptop|desktop)\\b`), "16:9");
  at(new RegExp(`\\b9\\s*[:x×]\\s*16\\b|\\b(?:vertical|portrait) ${fmt}\\b|\\b(?:in|as) (?:vertical|portrait)\\b|\\bvertically\\b|\\bfor (?:instagram |ig )?(?:reels?|tiktok|stories|shorts)\\b`), "9:16");
  at(new RegExp(`\\b1\\s*[:x×]\\s*1\\b|\\bsquare ${fmt}\\b|\\b(?:in|as) (?:a )?square\\b`), "1:1");
  // An explicit ratio beats a word; otherwise the first one said wins.
  const exact = /\b(16|9|1)\s*[:x×]\s*(9|16|1)\b/.exec(t);
  if (exact) {
    const r = `${exact[1]}:${exact[2]}` as Ratio;
    if (r === "16:9" || r === "9:16" || r === "1:1") return r;
  }
  hits.sort((a, b) => a[0] - b[0]);
  return hits[0]?.[1] ?? null;
}
