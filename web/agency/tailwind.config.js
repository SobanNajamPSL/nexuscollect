import preset from "../shared/tailwind-preset.js";

/** @type {import('tailwindcss').Config} */
export default {
  presets: [preset],
  content: ["./index.html", "./src/**/*.{ts,tsx}", "../shared/src/**/*.{ts,tsx}"],
  theme: {
    extend: {
      colors: {
        ag: {
          bg: "#f4f2ed",
          panel: "#fffdf9",
          panelAlt: "#f9f7f1",
          ink: "#1b1a17",
          inkDim: "#6b665c",
          rule: "#ddd8cc",
          primary: "#1e3a5f",
          primaryDark: "#152a46",
          accent: "#8a6d1f",
          good: "#1c6b47",
          warn: "#9a6b16",
          bad: "#96342c",
        },
      },
    },
  },
};
