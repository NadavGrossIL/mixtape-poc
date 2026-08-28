#!/usr/bin/env node
// Mixtape client for Hermes Agent (and anyone else with a shell).
//
// Talks to the live Mixtape server the same way the browser does: the SSE
// generate stream, the SSE adjust stream, and the playlist press. No API key —
// the server hands out a signed guest cookie on the first call, and this
// script keeps it in a jar so one Hermes install counts as one guest for the
// daily caps (5 per guest, 10 per IP, 12 for all guests together).
//
//   node mixtape.mjs generate "rainy drive through the negev"   → card, no press
//   node mixtape.mjs generate "..." --press                     → card + public playlist link
//   node mixtape.mjs adjust "less synth, one Israeli track"     → reworks the last card
//   node mixtape.mjs press                                      → presses the last card as-is
//
// Output is plain text meant for a chat reply, followed by nothing else. The
// full card JSON is kept at $MIXTAPE_STATE/last-card.json for the next step.

import fs from "node:fs";
import path from "node:path";
import os from "node:os";

const BASE = (process.env.MIXTAPE_URL || "https://mixtape-poc-production.up.railway.app").replace(/\/$/, "");
const STATE = process.env.MIXTAPE_STATE || path.join(os.homedir(), ".hermes", "mixtape");
const JAR = path.join(STATE, "cookie.txt");
const LAST = path.join(STATE, "last-card.json");
fs.mkdirSync(STATE, { recursive: true });

const [cmd, ...rest] = process.argv.slice(2);
const press = rest.includes("--press");
const text = rest.filter((a) => a !== "--press").join(" ").trim();

function cookieHeader() {
  try { return fs.readFileSync(JAR, "utf8").trim(); } catch { return ""; }
}
function keepCookies(res) {
  const set = res.headers.getSetCookie?.() || [];
  if (!set.length) return;
  // Merge by name so the guest id and the gate cookie both survive.
  const jar = new Map(cookieHeader().split(/;\s*/).filter(Boolean).map((c) => c.split("=", 1).concat(c.slice(c.indexOf("=") + 1))));
  for (const c of set) { const kv = c.split(";", 1)[0]; const k = kv.slice(0, kv.indexOf("=")); jar.set(k, kv.slice(k.length + 1)); }
  fs.writeFileSync(JAR, [...jar].map(([k, v]) => `${k}=${v}`).join("; "));
}

async function post(route, body, accept) {
  const res = await fetch(BASE + route, {
    method: "POST",
    headers: { "content-type": "application/json", accept, cookie: cookieHeader() },
    body: JSON.stringify(body),
  });
  keepCookies(res);
  if (!res.ok) {
    let msg = `${res.status} ${res.statusText}`;
    try { msg = (await res.json()).error || msg; } catch {}
    throw new Error(msg);
  }
  return res;
}

// Read an SSE stream to its end; return the `done` payload, throw on `error`.
async function drainSSE(res, onEvent) {
  const reader = res.body.getReader();
  const dec = new TextDecoder();
  let buf = "", done = null;
  for (;;) {
    const { value, done: end } = await reader.read();
    if (end) break;
    buf += dec.decode(value, { stream: true });
    let i;
    while ((i = buf.indexOf("\n\n")) >= 0) {
      const chunk = buf.slice(0, i); buf = buf.slice(i + 2);
      const ev = /^event: (.*)$/m.exec(chunk)?.[1];
      const data = /^data: (.*)$/m.exec(chunk)?.[1];
      if (!ev) continue;
      const payload = data ? JSON.parse(data) : {};
      if (ev === "error") throw new Error(payload.error || payload.message || "server error");
      if (ev === "done") done = payload;
      else onEvent?.(ev, payload);
    }
  }
  if (!done) throw new Error("stream ended without a card");
  return done;
}

function describe(card) {
  const lines = [`🎧 ${card.title}`, card.vibe ? `_${card.vibe}_` : null, ""];
  card.tracks.forEach((t, i) => {
    const mark = t.resolved ? "" : "  (unverified — not on Spotify)";
    lines.push(`${i + 1}. ${t.artist} — ${t.title}${mark}`);
    if (t.note) lines.push(`   ${t.note}`);
  });
  return lines.filter((l) => l !== null).join("\n");
}

async function doPress(card) {
  const uris = card.tracks.filter((t) => t.resolved && t.spotifyUri).map((t) => t.spotifyUri);
  if (uris.length === 0) throw new Error("nothing verified to press");
  const res = await post("/api/playlist", { title: card.title, uris }, "application/json");
  const out = await res.json();
  return out.playlistUrl;
}

function loadLast() {
  try { return JSON.parse(fs.readFileSync(LAST, "utf8")); } catch { throw new Error("no previous mixtape — generate one first"); }
}

try {
  let card;
  if (cmd === "generate") {
    if (!text) throw new Error("usage: generate <prompt> [--press]");
    const res = await post("/api/generate/stream", { prompt: text }, "text/event-stream");
    process.stderr.write("curating…\n");
    ({ card } = await drainSSE(res, (ev, p) => { if (ev === "track") process.stderr.write(`  ${p.artist} — ${p.title}\n`); }));
  } else if (cmd === "adjust") {
    if (!text) throw new Error("usage: adjust <instruction> [--press]");
    const res = await post("/api/adjust/stream", { card: loadLast(), adjustment: text }, "text/event-stream");
    process.stderr.write("refining…\n");
    ({ card } = await drainSSE(res));
  } else if (cmd === "press") {
    card = loadLast();
  } else {
    throw new Error("usage: mixtape.mjs generate|adjust|press …");
  }
  fs.writeFileSync(LAST, JSON.stringify(card, null, 2));
  console.log(describe(card));
  if (press || cmd === "press") {
    const url = await doPress(card);
    console.log(`\nPressed. Open in Spotify, tap + to keep it:\n${url}`);
  } else {
    console.log(`\n(not pressed yet — say "press it" to make the Spotify playlist)`);
  }
} catch (err) {
  console.log(`Mixtape couldn't do that: ${err.message}`);
  process.exit(1);
}
