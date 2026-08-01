import preset from "../shared/tailwind-preset.js";

/** @type {import('tailwindcss').Config} */
export default {
  presets: [preset],
  content: ["./index.html", "./src/**/*.{ts,tsx}", "../shared/src/**/*.{ts,tsx}"],
  theme: {
    extend: {
      colors: {
        cz: {
          bg: "#f6f8f7",
          panel: "#ffffff",
          ink: "#14261f",
          inkDim: "#5f6f68",
          rule: "#dbe3df",
          primary: "#0f5132",
          primaryDark: "#0a3a24",
          accent: "#b08900",
          good: "#0f5132",
          bad: "#96342c",
        },
      },
    },
  },
};
