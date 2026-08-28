// Print the accounts in server/.tokens.json with their refresh tokens — the
// step between "logged in once locally" and "pasted into the host's env".
// Run: node scripts/list-tokens.ts
import fs from "node:fs";
import path from "node:path";

const file = path.join(import.meta.dirname, "..", "server", ".tokens.json");
let parsed: any;
try {
  parsed = JSON.parse(fs.readFileSync(file, "utf8"));
} catch {
  console.error(`no token store at ${file} — log in once via the local app first`);
  process.exit(1);
}
const users: Record<string, any> =
  parsed?.users || (parsed?.refresh_token ? { owner: parsed } : {});
for (const [id, t] of Object.entries(users)) {
  console.log(`${id}${t.display_name ? ` (${t.display_name})` : ""}`);
  console.log(`  refresh_token: ${t.refresh_token}\n`);
}
console.log("Host account: put the Mixtape account's refresh_token in SPOTIFY_HOST_REFRESH_TOKEN.");
