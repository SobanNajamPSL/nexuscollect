/**
 * Tokens every portal shares. Deliberately small: only the demonstration
 * harness (which must look identical everywhere, because it is *not* part of
 * any portal's product) and typography primitives. Each portal defines its own
 * palette on top — an agency portal facing a ministry should not look like a
 * teller's till.
 *
 * @type {import('tailwindcss').Config}
 */
export default {
  theme: {
    extend: {
      colors: {
        // The harness chrome. Intentionally cold and dark so it reads as
        // scaffolding around the product rather than part of it.
        harness: {
          bg: "#0b1220",
          bgAlt: "#161f33",
          border: "#2b3854",
          ink: "#c9d4e8",
          inkDim: "#7c8ba8",
          warn: "#e0a63c",
          danger: "#d4544a",
        },
      },
      fontFamily: {
        sans: ['"Inter"', '"Segoe UI"', "system-ui", "-apple-system", "sans-serif"],
        mono: ['"SF Mono"', '"JetBrains Mono"', "ui-monospace", "monospace"],
        urdu: ['"Noto Nastaliq Urdu"', "serif"],
      },
    },
  },
  plugins: [],
};
