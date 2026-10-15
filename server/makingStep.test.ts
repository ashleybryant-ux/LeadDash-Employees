import { describe, expect, it } from "vitest";
import { makingStep } from "@shared/makingStep";

describe("makingStep: the step list keeps moving after the recording", () => {
  it("is before the steps while the opening is read", () => {
    expect(makingStep("Reading the lines", 17)).toBeNull();
    expect(makingStep("Reading the opening", 17)).toBeNull();
    expect(makingStep(null, 17)).toBeNull();
  });

  it("names the step whose line is being read or spoken", () => {
    expect(makingStep("Reading step 3", 17)).toBe(3);
    expect(makingStep("The avatar says step 12", 17)).toBe(12);
    expect(makingStep("Reading step 40", 17)).toBe(17);
  });

  it("is past every step for the closing and the cutting", () => {
    expect(makingStep("Reading the closing", 17)).toBe("all");
    expect(makingStep("Making 16:9", 17)).toBe("all");
    expect(makingStep("Making 9:16 (2 of 2)", 17)).toBe("all");
  });
});
