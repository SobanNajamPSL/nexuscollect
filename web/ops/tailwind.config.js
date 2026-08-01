import preset from "../shared/tailwind-preset.js";

/** @type {import('tailwindcss').Config} */
export default {
  presets: [preset],
  content: ["./index.html", "./src/**/*.{ts,tsx}", "../shared/src/**/*.{ts,tsx}"],
  theme: {
    extend: {
      colors: {
        op: {
          bg: "#eef1f4",
          panel: "#ffffff",
          panelAlt: "#f6f8fa",
          ink: "#12181d",
          inkDim: "#5d6b78",
          rule: "#cdd6de",
          primary: "#22546e",
          primaryDark: "#183c50",
          accent: "#0d7d8a",
          good: "#136f43",
          warn: "#8a5a10",
          bad: "#9c2f27",
        },
      },
    },
  },
};
