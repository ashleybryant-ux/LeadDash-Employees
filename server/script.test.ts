import { describe, expect, it } from "vitest";
import { MAX_SHOT_WORDS, readScript, scriptSeconds, splitLine, wordsIn } from "@shared/script";
import { castNameFor, fitScript } from "./employees/scene";
import type { Shot } from "./employees/drama";

const LONG = "I looked at every chart from last week, and the numbers say we are behind on the Pace notes. We need a plan before Friday, or the auditors will find it first. Can you start on it today?";

describe("readScript: her script is read line by line", () => {
  it("reads NAME: line scripts, keeping every word and the directions apart", () => {
    const s = readScript(`Setting: a bright modern office\n\nDR. COHEN: (leaning in) Are we on pace this week?\nHarper: We are. Two notes left, and both are drafted.\nDr. Cohen: Good. Send them to me by noon.`);
    expect(s).toEqual([
      { who: "Dr. Cohen", text: "Are we on pace this week?", note: "leaning in" },
      { who: "Harper", text: "We are. Two notes left, and both are drafted.", note: "" },
      { who: "Dr. Cohen", text: "Good. Send them to me by noon.", note: "" },
    ]);
  });

  it("reads a screenplay, with the name in capitals over the words", () => {
    const s = readScript(`INT. OFFICE - DAY\n\nMAYA\n(quietly)\nI need this done today.\nNot tomorrow.\n\nJORDAN\nThen it's done today.`);
    expect(s).toEqual([
      { who: "Maya", text: "I need this done today. Not tomorrow.", note: "quietly" },
      { who: "Jordan", text: "Then it's done today.", note: "" },
    ]);
  });

  it("a description is not a script", () => {
    expect(readScript("A cinematic trailer where Dr. Cohen asks her AI team if they're on pace, and Harper answers.")).toBeNull();
    expect(readScript("Tone: funny\nLength: 30 seconds\nMaya: a therapist in her 40s, braids\nJordan: a front desk lead")).toBeNull();
  });

  it("a brief's section headings and casting notes are never lines (2026-10-16)", () => {
    const brief = [
      "Make a new scene called The Bench. 30 seconds, 16:9. I am not in it.",
      "",
      "THE LOOK",
      "Shot on anamorphic 35mm lenses, shallow depth of field.",
      "",
      "THE PEOPLE",
      "Dr. Maya Ellis, owner of the practice: Black woman, early 40s, hair in a low bun.",
      "Harper: composed and quietly confident, dressed in a fitted navy suit.",
      "Camille: precise and steady, in a deep burgundy blazer over a black top.",
      "",
      "THE SHOTS",
      "1. (4 seconds, no dialogue) Wide shot of the office at night.",
      "",
      "THE LINES (use these word for word)",
      "Maya: I can't keep doing this by myself. [shot 2]",
      "Harper: Since you opened the practice. [shot 5]",
      "Camille: We'll take it from here. Go home, Maya.",
    ].join("\n");
    expect(readScript(brief)).toEqual([
      { who: "Maya", text: "I can't keep doing this by myself.", note: "shot 2" },
      { who: "Harper", text: "Since you opened the practice.", note: "shot 5" },
      { who: "Camille", text: "We'll take it from here. Go home, Maya.", note: "" },
    ]);
    // Without a lines heading, the headings and casting notes are still skipped.
    const noHeading = brief.replace("THE LINES (use these word for word)", "");
    expect(readScript(noHeading)!.map((l) => l.who)).toEqual(["Maya", "Harper", "Camille"]);
  });

  it("its length comes from the words, not a default", () => {
    const s = readScript(Array.from({ length: 12 }, (_, i) => `${i % 2 ? "Harper" : "Maya"}: ${LONG}`).join("\n"))!;
    expect(s).toHaveLength(12);
    expect(scriptSeconds(s)).toBeGreaterThan(150);
  });
});

describe("splitLine: a long line runs over shots without losing a word", () => {
  it("cuts at sentence ends and keeps every word in order", () => {
    const parts = splitLine(LONG);
    expect(parts.length).toBeGreaterThan(1);
    expect(parts.join(" ")).toBe(LONG);
    for (const p of parts) expect(wordsIn(p)).toBeLessThanOrEqual(MAX_SHOT_WORDS);
  });
  it("a short line stays one line", () => {
    expect(splitLine("Are we on pace?")).toEqual(["Are we on pace?"]);
  });
});

const shot = (n: number, extra: Partial<Shot> = {}): Shot => ({ n, framing: "Medium", move: "Static", action: `Shot ${n}`, setting: "Office", cast: [], line: null, seconds: 4, scene: 1, flow: "cut", status: "todo", ...extra });

describe("fitScript: her words go on the shots exactly", () => {
  const script = readScript(`Dr. Cohen: Are we on pace this week?\nHarper: ${LONG}\nDr. Cohen: Good.`)!;
  const names = ["Dr. Rachel Cohen", "Harper"];

  it("matches a speaker to the cast name that holds it", () => {
    expect(castNameFor("Dr. Cohen", names)).toBe("Dr. Rachel Cohen");
    expect(castNameFor("HARPER", names)).toBe("Harper");
    expect(castNameFor("Jordan", names)).toBeNull();
  });

  it("uses the script's words, not the writer's, adds a shot for a line it left out, and keeps the order", () => {
    const out = fitScript(
      [
        { shot: shot(1), ref: 0 },
        { shot: shot(2, { line: { who: "Harper", text: "Reworded by the writer" } }), ref: 2 },
        { shot: shot(3, { cast: ["Dr. Rachel Cohen"], line: { who: "Dr. Rachel Cohen", text: "Are we good?" } }), ref: 1 },
        { shot: shot(4), ref: 0 },
      ],
      script,
      names
    );
    const spoken = out.filter((s) => s.line);
    expect(spoken[0].line).toEqual({ who: "Dr. Rachel Cohen", text: "Are we on pace this week?" });
    expect(spoken.filter((s) => s.line!.who === "Harper").map((s) => s.line!.text).join(" ")).toBe(LONG);
    expect(spoken[spoken.length - 1].line).toEqual({ who: "Dr. Rachel Cohen", text: "Good." });
    expect(out[0].line).toBeNull();
    expect(out.map((s) => s.n)).toEqual(out.map((_, i) => i + 1));
    for (const s of spoken) {
      expect(s.cast).toContain(s.line!.who);
      expect(wordsIn(s.line!.text)).toBeLessThanOrEqual(MAX_SHOT_WORDS);
      expect(s.seconds).toBeLessThanOrEqual(7);
    }
    // The long line carries straight on from one shot of Harper to the next.
    const harper = out.filter((s) => s.line?.who === "Harper");
    expect(harper.length).toBeGreaterThan(1);
    expect(harper[0].flow).toBe("continue");
  });
});
