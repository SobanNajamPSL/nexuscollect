// @ts-check
import tsParser from "@typescript-eslint/parser";
import tsPlugin from "@typescript-eslint/eslint-plugin";

// CLAUDE.md "Demo mode": no new Date() / Date.now() anywhere in src/, except
// inside platform/clock itself, which is the one place allowed to touch the
// system clock (it's what DEMO_MODE pins). A test proving this rule fires
// lives at test/unit/no-system-clock.test.ts.
// Zero-argument `new Date()` reads the system clock and is banned. `new Date(iso)`
// (parsing a fixed timestamp string — e.g. historical demo-data or an API payload)
// is a different operation entirely and is allowed; the AST distinguishes them by
// argument count.
const noSystemClockRule = {
  selector: "NewExpression[callee.name='Date'][arguments.length=0]",
  message: "Do not call `new Date()` in src/ — use the injected Clock from platform/clock instead (see CLAUDE.md Demo mode).",
};
const noDateNowRule = {
  selector: "CallExpression[callee.object.name='Date'][callee.property.name='now']",
  message: "Do not call `Date.now()` in src/ — use the injected Clock from platform/clock instead (see CLAUDE.md Demo mode).",
};

export default [
  {
    files: ["src/**/*.ts"],
    ignores: ["src/platform/clock/**"],
    languageOptions: {
      parser: tsParser,
      parserOptions: { sourceType: "module" },
    },
    plugins: { "@typescript-eslint": tsPlugin },
    rules: {
      "no-restricted-syntax": ["error", noSystemClockRule, noDateNowRule],
    },
  },
];
