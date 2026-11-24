#!/usr/bin/env node
// record-demo: drive the real app through a scenario (JSON steps) in headless
// Chromium, record it with Playwright's recordVideo, convert to MP4 (+ GIF).
//
//   node record-demo.mjs <scenario.json> [--base http://127.0.0.1:8889]
//        [--mode replay|capture] [--viewport phone|laptop|WxH]
//        [--out <dir>] [--gif false] [--fixture <name>] [--fixtures <dir>]
//
// Why replay exists: every live generation is a paid Anthropic run plus a
// slice of the day's Spotify search quota. A demo gets re-recorded many times
// (pacing, a wrong selector, a CSS tweak), so the card's SSE stream is captured
// once (--mode capture) and every later recording replays it for free.
//
// Why replay overrides window.fetch instead of using page.route().fulfill():
// fulfill() hands the page the whole body at once, so the card would pop in
// fully formed — the streaming is the thing worth showing. A ReadableStream
// built in the page can pace events out. page.route() is still installed in
// replay mode, as a tripwire that aborts any stream request that slips past
// the override, so a replay can never spend money.
//
// Playwright is not a project dependency (package.json is on the ask tier).
// It lives in ~/.cache/mixtape-record-demo, pinned to 1.62.1 because that
// release uses chromium build 1234, already in ~/Library/Caches/ms-playwright.

import { createRequire } from "node:module";
import { readFileSync, writeFileSync, mkdirSync, existsSync, statSync, rmSync, readdirSync } from "node:fs";
import { dirname, join, resolve, basename } from "node:path";
import { homedir, tmpdir } from "node:os";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const PW_PREFIX = process.env.RECORD_DEMO_PW || join(homedir(), ".cache/mixtape-record-demo");
const FFMPEG = process.env.FFMPEG || "/opt/homebrew/bin/ffmpeg";
// the repo root: first ancestor holding server/index.ts (works from
// .skill-staging/record-demo and from .claude/skills/record-demo alike)
const REPO = (() => {
  for (let d = HERE; d !== dirname(d); d = dirname(d))
    if (existsSync(join(d, "server/index.ts"))) return d;
  return process.cwd();
})();
const STREAM_PATHS = ["/api/generate/stream", "/api/adjust/stream"];
const VIEWPORTS = { phone: { width: 390, height: 844 }, laptop: { width: 1280, height: 800 } };

// ── args ─────────────────────────────────────────────────────
const argv = process.argv.slice(2);
const flag = (name, dflt) => {
  const i = argv.indexOf(`--${name}`);
  if (i === -1) return dflt;
  const v = argv[i + 1];
  return v === undefined || v.startsWith("--") ? true : v;
};
const scenarioPath = argv.find((a) => !a.startsWith("--") && a.endsWith(".json"));
if (!scenarioPath) {
  console.error("usage: node record-demo.mjs <scenario.json> [--base URL] [--mode replay|capture] [--viewport phone|laptop|WxH] [--out DIR] [--gif]");
  process.exit(2);
}
const scenario = JSON.parse(readFileSync(scenarioPath, "utf8"));
const name = scenario.name || basename(scenarioPath, ".json");
const base = String(flag("base", scenario.base || "http://127.0.0.1:8889")).replace(/\/$/, "");
const mode = flag("mode", "replay");
const outDir = resolve(flag("out", join(REPO, "docs/demos")));
const wantGif = !["false", "0", "no"].includes(String(flag("gif", scenario.gif ?? true)));
const fixtureName = flag("fixture", scenario.fixture || name);
// Fixtures sit beside the scenarios (<scenario dir>/../fixtures), so the two
// travel together, and a capture never writes into the skill's own folder
// once it lives under .claude/ (never tier).
const fixtureDir = resolve(String(flag("fixtures", join(dirname(resolve(scenarioPath)), "../fixtures"))));
const fixtureFile = (path) =>
  join(fixtureDir, `${fixtureName}${path.includes("adjust") ? ".adjust" : ""}.sse`);
const vpArg = flag("viewport", scenario.viewport || "phone");
const viewport =
  VIEWPORTS[vpArg] ||
  (/^\d+x\d+$/.test(vpArg) ? { width: +vpArg.split("x")[0], height: +vpArg.split("x")[1] } : null);
if (!viewport) throw new Error(`unknown viewport ${vpArg}`);
if (!["replay", "capture"].includes(mode)) throw new Error(`--mode must be replay or capture`);
// Pacing of the replayed stream, ms before each event by name.
const pace = { track: 650, resolved: 220, default: 450, ...(scenario.pace || {}) };

// ── fixtures ─────────────────────────────────────────────────
// A fixture is the raw text/event-stream body, split here into events.
function loadFixtures() {
  const out = {};
  for (const p of STREAM_PATHS) {
    const f = fixtureFile(p);
    if (!existsSync(f)) continue;
    const events = readFileSync(f, "utf8")
      .split("\n\n")
      .filter((e) => e.trim())
      .map((e) => {
        const ev = /^event: ?(.*)$/m.exec(e)?.[1] ?? "message";
        return { chunk: e + "\n\n", delay: pace[ev] ?? pace.default };
      });
    out[p] = events;
  }
  return out;
}

// Runs in the page (stringified): a cursor dot so a viewer can follow the
// mouse, and in replay mode a fetch override that streams the fixture.
function pageInit({ fixtures, showCursor }) {
  if (showCursor) {
    const install = () => {
      if (document.getElementById("__demo_cursor")) return;
      const dot = document.createElement("div");
      dot.id = "__demo_cursor";
      dot.style.cssText =
        "position:fixed;z-index:2147483647;pointer-events:none;width:22px;height:22px;" +
        "margin:-11px 0 0 -11px;border-radius:50%;background:rgba(255,80,60,.35);" +
        "border:2px solid rgba(255,80,60,.9);left:-50px;top:-50px;" +
        "transition:transform .12s ease,background .12s ease";
      document.documentElement.appendChild(dot);
      addEventListener("mousemove", (e) => {
        dot.style.left = e.clientX + "px";
        dot.style.top = e.clientY + "px";
      }, true);
      addEventListener("mousedown", () => {
        dot.style.transform = "scale(.7)";
        dot.style.background = "rgba(255,80,60,.75)";
      }, true);
      addEventListener("mouseup", () => {
        dot.style.transform = "";
        dot.style.background = "rgba(255,80,60,.35)";
      }, true);
    };
    if (document.readyState === "loading") addEventListener("DOMContentLoaded", install);
    else install();
  }
  if (!fixtures) return;
  const realFetch = window.fetch.bind(window);
  window.fetch = (input, init) => {
    const url = new URL(typeof input === "string" ? input : input.url, location.href);
    const events = fixtures[url.pathname];
    if (!events) return realFetch(input, init);
    const enc = new TextEncoder();
    const signal = init?.signal;
    const body = new ReadableStream({
      async start(ctrl) {
        for (const e of events) {
          await new Promise((r) => setTimeout(r, e.delay));
          if (signal?.aborted) return ctrl.error(new DOMException("aborted", "AbortError"));
          ctrl.enqueue(enc.encode(e.chunk));
        }
        ctrl.close();
      },
    });
    return Promise.resolve(
      new Response(body, { status: 200, headers: { "Content-Type": "text/event-stream" } }),
    );
  };
}

// ── steps ────────────────────────────────────────────────────
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function moveTo(page, selector) {
  const loc = page.locator(selector).first();
  await loc.scrollIntoViewIfNeeded();
  const box = await loc.boundingBox();
  if (!box) throw new Error(`no box for ${selector}`);
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2, { steps: 25 });
  return loc;
}

async function runStep(page, step, i) {
  const [kind, arg] = Object.entries(step)[0];
  const label = `step ${i + 1} ${kind}`;
  console.log(`  ${label}: ${JSON.stringify(arg)}`);
  const waitTimeout = mode === "capture" ? 180_000 : 60_000;
  switch (kind) {
    case "goto":
      await page.goto(base + arg, { waitUntil: "networkidle" });
      break;
    case "click":
      await moveTo(page, arg);
      await sleep(250);
      await page.locator(arg).first().click();
      await sleep(400);
      break;
    case "hover":
      await moveTo(page, arg);
      break;
    case "type": {
      await moveTo(page, arg.selector);
      await page.locator(arg.selector).first().click();
      await page.keyboard.type(arg.text, { delay: arg.delay ?? 70 });
      break;
    }
    case "press":
      await page.keyboard.press(arg);
      break;
    case "waitFor": {
      const o = typeof arg === "string" ? { selector: arg } : arg;
      const timeout = o.timeout ?? waitTimeout;
      if (o.min) {
        await page.waitForFunction(
          ([s, n]) => document.querySelectorAll(s).length >= n,
          [o.selector, o.min],
          { timeout },
        );
      } else {
        await page.locator(o.selector).first().waitFor({ state: o.state || "visible", timeout });
      }
      break;
    }
    case "pause":
      await sleep(arg);
      break;
    case "scroll": {
      // smooth-scroll an element to the middle of the screen
      const o = typeof arg === "string" ? { selector: arg } : arg;
      await page.locator(o.selector).first().evaluate((el, block) =>
        el.scrollIntoView({ behavior: "smooth", block }), o.block || "center");
      await sleep(o.ms ?? 1200);
      break;
    }
    case "scrollBy": {
      // a slow, readable scroll: y px over ms, in small increments
      const { y, ms = 3000 } = arg;
      const n = Math.max(1, Math.round(ms / 40));
      for (let k = 0; k < n; k++) {
        await page.evaluate((d) => window.scrollBy(0, d), y / n);
        await sleep(40);
      }
      break;
    }
    default:
      throw new Error(`${label}: unknown step kind "${kind}"`);
  }
}

// ── main ─────────────────────────────────────────────────────
const require = createRequire(join(PW_PREFIX, "node_modules/"));
let chromium;
try {
  ({ chromium } = require("playwright"));
} catch {
  console.error(`playwright not found under ${PW_PREFIX}. Install it there:\n  npm i --prefix ${PW_PREFIX} playwright@1.62.1`);
  process.exit(2);
}

const fixtures = mode === "replay" ? loadFixtures() : null;
if (mode === "replay" && !fixtures["/api/generate/stream"] && scenario.needsGenerate !== false) {
  console.error(`no fixture at ${fixtureFile("/api/generate/stream")}.\nRun once with --mode capture (costs one paid generation).`);
  process.exit(2);
}

mkdirSync(outDir, { recursive: true });
const rawDir = join(tmpdir(), `record-demo-${process.pid}`); // not HERE: that is .claude/ once installed
rmSync(rawDir, { recursive: true, force: true });
mkdirSync(rawDir, { recursive: true });

const browser = await chromium.launch();
const context = await browser.newContext({
  viewport,
  colorScheme: scenario.colorScheme || "light",
  // size = viewport: recordVideo captures at CSS pixels, so a 2x size (tried
  // with deviceScaleFactor 2) only pads the frame with grey, it adds no detail.
  recordVideo: { dir: rawDir, size: viewport },
});
await context.addInitScript(pageInit, { fixtures, showCursor: scenario.cursor !== false });

const captured = {};
if (mode === "replay") {
  // tripwire: the fetch override should have answered already
  for (const p of STREAM_PATHS) {
    await context.route(`**${p}*`, (route) => {
      console.error(`replay: ${p} reached the network — aborted (no fixture for it?)`);
      return route.abort();
    });
  }
} else {
  for (const p of STREAM_PATHS) {
    await context.route(`**${p}*`, async (route) => {
      console.log(`capture: live ${p} (paid run) ...`);
      const resp = await route.fetch({ timeout: 300_000 });
      const body = await resp.text();
      if (resp.status() === 200 && body.includes("event: done")) {
        mkdirSync(fixtureDir, { recursive: true });
        writeFileSync(fixtureFile(p), body);
        captured[p] = fixtureFile(p);
        console.log(`capture: saved ${fixtureFile(p)} (${body.length} bytes)`);
      } else {
        console.error(`capture: ${p} returned ${resp.status()} without a done event — not saved:\n${body.slice(0, 500)}`);
      }
      await route.fulfill({ response: resp, body });
    });
  }
}

const t0 = Date.now();
const page = await context.newPage();
let failed = null;
let startTrim = 0;
try {
  const steps = scenario.steps;
  if (!steps?.length || !("goto" in steps[0])) steps.unshift({ goto: scenario.path || "/" });
  for (let i = 0; i < steps.length; i++) {
    await runStep(page, steps[i], i);
    // trim the blank page-load frames off the front of the video
    if (i === 0) startTrim = Math.max(0, (Date.now() - t0) / 1000 - 0.3);
  }
  await sleep(scenario.tail ?? 1500);
} catch (err) {
  failed = err;
  console.error(`FAILED: ${err.message}`);
  await page.screenshot({ path: join(outDir, `${name}.failure.png`) }).catch(() => {});
}
const video = page.video();
await context.close();
await browser.close();
const webm = await video.path();

if (mode === "capture") {
  console.log(`capture done: ${Object.values(captured).join(", ") || "nothing saved"}`);
  console.log("Now render with --mode replay (the capture video is not kept: its card arrives all at once).");
  rmSync(rawDir, { recursive: true, force: true });
  process.exit(failed || !Object.keys(captured).length ? 1 : 0);
}
if (failed) process.exit(1);

// ── convert ──────────────────────────────────────────────────
const mp4 = join(outDir, `${name}.mp4`);
execFileSync(FFMPEG, [
  "-y", "-loglevel", "error", "-ss", startTrim.toFixed(2), "-i", webm,
  "-c:v", "libx264", "-pix_fmt", "yuv420p", "-preset", "slow", "-crf", "22",
  "-vf", "scale=trunc(iw/2)*2:trunc(ih/2)*2", "-movflags", "+faststart", mp4,
]);
const dur = Number(
  execFileSync(FFMPEG.replace(/ffmpeg$/, "ffprobe"), [
    "-v", "error", "-show_entries", "format=duration", "-of", "csv=p=0", mp4,
  ]).toString().trim(),
);
const mb = (f) => (statSync(f).size / 1e6).toFixed(1) + " MB";
console.log(`mp4: ${mp4}  ${dur.toFixed(1)}s  ${mb(mp4)}`);

if (wantGif) {
  // palette GIF; step down fps/width until it fits ~10 MB, else skip it
  const gif = join(outDir, `${name}.gif`);
  // A scrolling card changes most pixels every frame, so a phone-width GIF of
  // ~35 s lands at 14 MB at 10 fps; 8 fps at 320 px is ~8 MB (measured).
  const tries = [[10, 390, "bayer"], [8, 320, "bayer"], [8, 280, "none"]];
  let ok = false;
  for (const [fps, w, dither] of tries) {
    const f = `fps=${fps},scale=${Math.min(w, viewport.width)}:-1:flags=lanczos`;
    execFileSync(FFMPEG, [
      "-y", "-loglevel", "error", "-i", mp4, "-vf",
      `${f},split[a][b];[a]palettegen=max_colors=128:stats_mode=diff[p];[b][p]paletteuse=dither=${dither}:diff_mode=rectangle`,
      gif,
    ]);
    if (statSync(gif).size <= 10e6) { ok = true; break; }
  }
  if (ok) console.log(`gif: ${gif}  ${mb(gif)}`);
  else { rmSync(gif); console.log("gif: skipped (over 10 MB even at 8 fps / 280 px)"); }
}
rmSync(rawDir, { recursive: true, force: true });
