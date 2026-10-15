import { describe, expect, it } from "vitest";
import { alignWords } from "./employees/wordTimes";

const heard = (s: string, start: number, step = 0.3) => s.split(" ").map((word, i) => ({ word, start: +(start + i * step).toFixed(2), end: +(start + i * step + 0.25).toFixed(2) }));

describe("alignWords: the captions follow the voice", () => {
  it("gives every script word the time it was heard at", () => {
    const { words, matched } = alignWords("Start on the Dashboard.", heard("Start on the Dashboard", 0.5), 2);
    expect(matched).toBe(4);
    expect(words.map((w) => w.text)).toEqual(["Start", "on", "the", "Dashboard."]);
    expect(words[0].start).toBe(0.5);
    expect(words[3].start).toBe(1.4);
  });

  it("keeps a pause in the voice as a pause in the captions, where spreading evenly would not", () => {
    // A long pause after "note" before "Click".
    const h = [...heard("Click Write note", 0), ...heard("Click Write note on any row", 4)];
    const { words } = alignWords("Click Write note. Click Write note on any row.", h, 6);
    expect(words[2].start).toBe(0.6);
    expect(words[3].start).toBe(4);
  });

  it("fills in a word the listening missed from its neighbors, never running backwards", () => {
    const h = [...heard("The top bar tells", 0), ...heard("whose note this is", 1.5)];
    const { words, matched } = alignWords("The top bar tells you whose note this is", h, 3);
    expect(matched).toBe(8);
    const you = words[4];
    expect(you.start).toBeGreaterThanOrEqual(words[3].end);
    expect(you.end).toBeLessThanOrEqual(words[5].start + 0.001);
    for (let i = 1; i < words.length; i++) expect(words[i].start).toBeGreaterThanOrEqual(words[i - 1].end - 0.001);
  });

  it("a word said twice or wrongly does not throw the rest off", () => {
    const h = [...heard("The the Note Style card", 0), ...heard("is where you chose your format", 2)];
    const { words } = alignWords("The Note Style card is where you choose your format.", h, 4.5);
    expect(words[0].text).toBe("The");
    expect(words[4].text).toBe("is");
    expect(words[4].start).toBe(2);
    expect(words[9].text).toBe("format.");
    expect(words[9].start).toBe(3.5);
  });
});
