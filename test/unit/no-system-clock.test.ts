import { join } from "node:path";
import { ESLint } from "eslint";
import { describe, expect, it } from "vitest";

/**
 * PROMPTS.md Prompt 0, acceptance test 8: "A lint rule fails the build on
 * `new Date()` or `Date.now()` inside src/." Runs the real eslint.config.js
 * against in-memory fixture text rather than re-implementing the rule's logic,
 * so this test would actually fail if eslint.config.js regressed.
 */
describe("ESLint: no system clock outside platform/clock", () => {
  async function lint(relativePath: string, code: string): Promise<ESLint.LintResult[]> {
    const eslint = new ESLint({
      cwd: process.cwd(),
      overrideConfigFile: "eslint.config.js",
    });
    // lintText doesn't need the file to exist on disk — filePath is only used to
    // match `files`/`ignores` patterns (e.g. the src/platform/clock/** exemption)
    // and for reporting.
    const virtualPath = join(process.cwd(), relativePath);
    return eslint.lintText(code, { filePath: virtualPath });
  }

  it("fails on `new Date()` in an ordinary src/ file", async () => {
    const results = await lint("src/modules/example/index.ts", "export const now = new Date();\n");
    const messages = results.flatMap((r) => r.messages);
    expect(messages.some((m) => m.ruleId === "no-restricted-syntax")).toBe(true);
  });

  it("fails on `Date.now()` in an ordinary src/ file", async () => {
    const results = await lint("src/modules/example/index.ts", "export const now = Date.now();\n");
    const messages = results.flatMap((r) => r.messages);
    expect(messages.some((m) => m.ruleId === "no-restricted-syntax")).toBe(true);
  });

  it("allows `new Date(isoString)` — parsing a fixed timestamp is not reading the system clock", async () => {
    const results = await lint("src/modules/example/index.ts", 'export const d = new Date("2026-07-30T00:00:00Z");\n');
    const messages = results.flatMap((r) => r.messages);
    expect(messages.some((m) => m.ruleId === "no-restricted-syntax")).toBe(false);
  });

  it("allows `new Date()` inside platform/clock, the one sanctioned exception", async () => {
    const results = await lint("src/platform/clock/example.ts", "export const now = new Date();\n");
    const messages = results.flatMap((r) => r.messages);
    expect(messages.some((m) => m.ruleId === "no-restricted-syntax")).toBe(false);
  });
});
