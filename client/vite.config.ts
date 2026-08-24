import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

// /api, /auth and /callback are proxied to the Express server so the client
// can use relative URLs everywhere.
export default defineConfig({
  plugins: [react()],
  server: {
    // 127.0.0.1, NOT localhost: identity rides HttpOnly cookies, and the
    // Spotify callback lands on 127.0.0.1:8888 (Spotify requires the
    // loopback IP literal as the redirect host). Cookies ignore ports but
    // not hostnames — dev served from "localhost" would set the OAuth state
    // and session cookies on a host the callback never sees, and login
    // would die with "State mismatch". One host everywhere fixes it.
    host: "127.0.0.1",
    proxy: {
      "/api": "http://127.0.0.1:8888",
      "/auth": "http://127.0.0.1:8888",
      "/callback": "http://127.0.0.1:8888",
    },
  },
});
