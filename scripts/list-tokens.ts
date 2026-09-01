// Print the accounts in server/.tokens.json — the step between "logged in
// once locally" and "pasted into the host's env".
// Run: node scripts/list-tokens.ts            # tokens masked
//      node scripts/list-tokens.ts --reveal   # full tokens, to copy once
//
// Masked by default because the printed value is a long-lived Spotify
// credential: unmasked it lands in terminal scrollback, tmux buffers and any
// screen share for the rest of the session, and there is no way to revoke just
// that copy. The deploy step genuinely needs the full value once, so --reveal
// keeps it reachable — deliberately, and only when asked for.
import fs from "node:fs";
import path from "node:path";

const reveal = process.argv.includes("--reveal");
const file = path.join(import.meta.dirname, "..", "server", ".tokens.json");
let parsed: any;
try {
  parsed = JSON.parse(fs.readFileSync(file, "utf8"));
} catch {
  console.error(`no token store at ${file} — log in once via the local app first`);
  process.exit(1);
}
// Six characters is enough to tell two accounts' tokens apart when checking
// which one you already pasted, and far short of anything usable.
const mask = (t: string) =>
  typeof t === "string" && t.length > 6 ? `${t.slice(0, 6)}… (${t.length} chars, --reveal to show)` : "(none)";
const users: Record<string, any> =
  parsed?.users || (parsed?.refresh_token ? { owner: parsed } : {});
for (const [id, t] of Object.entries(users)) {
  console.log(`${id}${t.display_name ? ` (${t.display_name})` : ""}`);
  console.log(`  refresh_token: ${reveal ? t.refresh_token : mask(t.refresh_token)}\n`);
}
console.log("Host account: put the Mixtape account's refresh_token in SPOTIFY_HOST_REFRESH_TOKEN.");
if (!reveal) console.log("Re-run with --reveal to print the full tokens.");
