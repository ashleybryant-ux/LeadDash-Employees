import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import path from "node:path";

/**
 * The deploy script (2026-11-12): the slow steps run only when they are
 * needed, the video render test runs by itself, and --quick leaves the tests
 * out but never the build, the boot check or the health check.
 */
const file = path.resolve(import.meta.dirname, "..", "deploy.sh");
const sh = readFileSync(file, "utf8");

describe("deploy.sh", () => {
  it("is valid bash", () => {
    execFileSync("bash", ["-n", file]);
  });

  it("installs packages only when the package list changed, and records it only after the install", () => {
    const install = sh.indexOf("npm ci --no-audit --no-fund");
    const record = sh.indexOf('echo "$LOCK_NOW" > node_modules/.leaddash-lock');
    expect(install).toBeGreaterThan(-1);
    expect(record).toBeGreaterThan(install);
    expect(sh).toContain('if [ -d node_modules ] && [ "$LOCK_NOW" = "$LOCK_DONE" ]; then');
  });

  it("always checks that the browser launches", () => {
    expect(sh).toContain("require('playwright-core').chromium.launch");
    const skip = sh.indexOf("download check skipped");
    const launch = sh.indexOf("chromium.launch");
    expect(launch).toBeGreaterThan(skip);
  });

  it("runs the video render test by itself, after the others", () => {
    const rest = sh.indexOf("npx vitest run --silent --exclude server/edits.test.ts");
    const alone = sh.indexOf("npx vitest run --silent server/edits.test.ts");
    expect(rest).toBeGreaterThan(-1);
    expect(alone).toBeGreaterThan(rest);
  });

  it("--quick skips only the tests", () => {
    const quick = sh.indexOf('if [ "$QUICK" = "1" ]; then');
    const build = sh.indexOf("npm run build");
    const boot = sh.indexOf("== boot check");
    const health = sh.indexOf("/api/health");
    expect(quick).toBeGreaterThan(-1);
    expect(build).toBeGreaterThan(quick);
    expect(boot).toBeGreaterThan(build);
    expect(health).toBeGreaterThan(-1);
    expect(sh.match(/QUICK/g)!.length).toBe(3);
  });
});
