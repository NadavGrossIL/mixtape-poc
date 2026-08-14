// Load server/.env before any sibling module reads process.env at load time
// (spotify.ts computes REDIRECT_URI when it is evaluated). index.ts imports
// this module first — ESM evaluates imports in declaration order.
import path from "node:path";
import { config } from "dotenv";

config({ path: path.join(import.meta.dirname, ".env") });
