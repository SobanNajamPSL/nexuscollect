/** @type {import('tailwindcss').Config} */
export default {
  content: ["./index.html", "./src/**/*.{js,ts,jsx,tsx}"],
  theme: {
    extend: {
      colors: {
        gov: {
          bg: "#f4f6f5",
          panel: "#ffffff",
          ink: "#1c2b26",
          primary: "#0f5132",
          primaryDark: "#0a3a24",
          accent: "#b08900",
          border: "#d8ddda",
        },
      },
    },
  },
  plugins: [],
};
