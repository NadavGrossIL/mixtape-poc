import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

// /api, /auth and /callback are proxied to the Express server so the client
// can use relative URLs everywhere.
export default defineConfig({
  plugins: [react()],
  server: {
    proxy: {
      "/api": "http://127.0.0.1:8888",
      "/auth": "http://127.0.0.1:8888",
      "/callback": "http://127.0.0.1:8888",
    },
  },
});
