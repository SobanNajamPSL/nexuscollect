import preset from "../shared/tailwind-preset.js";

/** @type {import('tailwindcss').Config} */
export default {
  presets: [preset],
  content: ["./index.html", "./src/**/*.{ts,tsx}", "../shared/src/**/*.{ts,tsx}"],
  theme: {
    extend: {
      colors: {
        fd: {
          bg: "#ffffff",
          panel: "#ffffff",
          panelAlt: "#f2f4f3",
          ink: "#0a0d0c",
          inkDim: "#4a544f",
          rule: "#9aa5a0",
          primary: "#146c43",
          primaryDark: "#0d4a2e",
          accent: "#b45309",
          good: "#146c43",
          bad: "#a1231b",
        },
      },
    },
  },
};
