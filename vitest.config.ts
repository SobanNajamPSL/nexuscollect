import { configDefaults, defineConfig } from "vitest/config";

/**
 * The only reason this file exists: `.claude/worktrees/` can hold a full clone of
 * the repository from a parallel agent session, and Vitest's default discovery
 * walks into it — running every test twice and reporting doubled counts (594
 * instead of 297), which makes "did anything break?" needlessly ambiguous.
 *
 * Everything else stays on Vitest's defaults deliberately.
 */
export default defineConfig({
  test: {
    exclude: [...configDefaults.exclude, "**/.claude/**"],
  },
});
