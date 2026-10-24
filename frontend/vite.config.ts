import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";

export default defineConfig({
  plugins: [react(), tailwindcss()],
  css: {
    postcss: { plugins: [] },
  },
  build: {
    outDir: process.env.VERCEL === "1" ? "../public" : "dist",
  },
  server: {
    proxy: {
      "/api": "http://localhost:4000",
    },
  },
});
