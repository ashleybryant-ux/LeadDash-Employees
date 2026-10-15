/**
 * Which step a video's making is on, read from the step label the server
 * writes while it reads the lines and cuts the video ("Reading step 3",
 * "The avatar says step 3", "Making 16:9"). The app uses it to keep the
 * step list and the recorded screen on view after the recording ends.
 *
 * Returns the 1-based step, null before the steps (the opening), or "all"
 * once past them (the closing, the cutting).
 */
export function makingStep(step: string | null | undefined, total: number): number | "all" | null {
  if (!step) return null;
  const m = /step (\d+)/i.exec(step);
  if (m) return Math.max(1, Math.min(total, Number(m[1])));
  if (/opening|^Reading the lines/i.test(step)) return null;
  return "all";
}
