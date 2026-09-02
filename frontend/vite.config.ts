import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";

// In dev, the Vite server proxies /api to the FastAPI backend on :7979 so the
// frontend and backend can run as separate processes with no CORS friction.
export default defineConfig({
  plugins: [react(), tailwindcss()],
  server: {
    port: 5173,
    proxy: {
      "/api": {
        target: "http://localhost:7979",
        changeOrigin: true,
      },
    },
  },
});
