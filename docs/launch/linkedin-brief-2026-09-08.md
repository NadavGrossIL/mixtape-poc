# LinkedIn launch brief — Mixtape

Written 2026-09-08 for the session that writes the post. Everything here is
verified against the repo or the live site on that date; file paths are where
to look if a claim needs re-checking. The post itself is Nadav's voice; this
is the material, two starting drafts, and the rules that keep the post honest.

## What the product is (the only pitch)

Type a mood → Claude curates 8 tracks in DJ-set order, with a one-line liner
note per track → every track is verified against Spotify → a record-sleeve
card → one tap presses it as a real, public playlist on the Mixtape host
account → the visitor opens it in Spotify and taps **+** to keep it.
**No Spotify login, no signup.** (`README.md:3-7`)

Live: `https://mixtape-poc-production.up.railway.app/` — public mode, the
URL is the invite, daily caps are the only door.

**Never lead with "connect your Spotify."** Spotify's dev mode caps the app
at 5 allowlisted accounts permanently; that button fails for every reader.
The guest path is the whole story (`docs/decisions/0002-*.md`).

## Claims the code can back (use these, quote them exactly)

1. **The model cannot invent a song.** It can only commit a track by quoting a
   `ref` it received from a real Spotify search result inside the run
   (`server/curator.ts`, the `ref` field on `TRACK_SCHEMA`; `verifyRef` in
   `server/spotify.ts`). A track without a usable ref is resolved by a real
   search; if that fails it is shown as **unverified** on the card and left
   off the playlist — not hidden. README calls this "the measurement, not a
   bug to hide."
2. **Liner-note truthfulness is measured, with real numbers.**
   - Eval harness: `evals/` — 19 prompts (`evals/prompts.json`), a Claude
     judge that checks every factual claim in a note against the catalog rows
     the model actually saw, and a deterministic grounding gate in
     `server/curator.ts` (~lines 457–857) that bounces a card claiming
     "opens the album" / "title track" / a year or length the row contradicts.
   - Baseline 2026-08-18: **24.0 %** of notes carried an invented fact
     (`.claude/rules/evals.md:8-11`, run `2026-08-18T07-45-44-348Z`).
   - Latest judged run 2026-08-31 (`evals/runs/2026-08-31T07-39-24-499Z/summary.json`):
     152 notes, **8 invented (5.3 %)**, 128 specific-true, 150/152 tracks
     resolved. Say "under 6 %", never "near zero" — roughly 1 card in 3
     still carries one false fact.
3. **Eight tracks by construction.** The tool schema uses eight *required*
   keys `track1…track8` instead of an array, because with an array the model
   closed it after one track in 6 of 10 live runs while announcing "all eight
   verified" (`docs/decisions/0001-keyed-object-over-array-in-tool-schema.md`).
   Good engineer-bait detail; one sentence, not more.
4. **Built mostly by Claude Code inside a spec → implement → review loop**
   with a permission tier that keeps the agent away from credentials, eval
   thresholds and the gate script (`CLAUDE.md` "Protection tiers",
   `docs/factory/plan.md`, `.claude/skills/`). Mention once; the full write-up
   is a second post a week later.
5. **A card takes about 30–50 s** (measured today on prod and locally). The UI
   says "about a minute" on purpose (under-promise).
6. **A dozen tapes a day.** `GUEST_TOTAL_DAILY_CAP=12` (`server/caps.ts`),
   sized to Spotify's dev-mode quota, not to cost. Resets at midnight UTC =
   03:00 Israel. Sold-out copy on the site: "today's tapes are all pressed —
   come back tomorrow." Frame it as scarcity in the post so visitor #40 reads
   the sold-out screen as intended, not as a crash.

## What NOT to claim

- Not "AI DJ", not "personalised to your taste" — it never reads the
  visitor's library (guests have no login).
- Not "zero hallucination" — see the 5.3 %.
- Not energy / tempo / BPM anything — Spotify removed audio-features for new
  apps in Nov 2024; the app never had them.
- Not "your playlist" — it lives on the Mixtape host account; the visitor
  *follows* it. "One tap to keep it" is the accurate phrase.
- Don't name Anthropic model IDs or costs.

## What shipped today (so the screenshots match the post)

PR #16, merged and deployed 2026-09-08: Spotify embed removed from the
pressed card, "5 test accounts" line hidden from the public page, card stamp
line now reads e.g. `SIDE A · 8 TRACKS · 36 MIN · 1970–1977` (runtime and era
from the verified Spotify rows), sticky "PRESS IT TO SPOTIFY" bar on phones.
Liner notes were **kept on purpose** after a five-agent review: they are the
one thing on screen Spotify's own AI playlist doesn't do.

## Audience and shape

- Israeli LinkedIn, mixed product/engineering network. Product hook first;
  engineering for whoever taps "see more." First ~210 characters are all most
  people see — they must contain the pitch and the try-it verb.
- **Media: a 15-second phone screen recording** (type a mood → disc spins →
  card → press → opens in Spotify). Native video out-reaches a link preview
  several times over. Record it from LinkedIn's in-app browser on a phone —
  that doubles as the last unfinished launch test (the webview → Spotify
  handoff).
- Link in the post text as well; the OG preview is verified (1200×630
  cassette card, `client/public/og.png`; run Post Inspector the night before,
  it caches 7 days).
- ≤ 3 hashtags at the bottom. Post Tue–Thu 08:00–10:00 Israel time (fresh
  daily cap, network online). Reply to every comment in the first two hours.
- Close with a question that yields prompts ("tell me the mood that broke
  it") — comments feed both reach and the next eval case.
- Terms that stay in English in the Hebrew post: liner notes, evals, spec /
  implement / review, Claude Code, Spotify. Put the URL on its own line
  (bidi). Check arrows/bullets render right-to-left on a phone.

## Draft A — English

```
I built a mixtape machine. Say the mood, get a real Spotify playlist.

"rainy sunday, coffee, mellow" → eight tracks that belong together, in order, with a line on each about why it's there → one tap and it's in your Spotify. No login, no signup.

→ mixtape-poc-production.up.railway.app

The part I actually care about is underneath.

Every track is verified against Spotify before you see it. The model can only commit a track by quoting a reference it got from a real search result, so it cannot invent a song. When it tries, the card says "unverified" instead of hiding it. Hallucination is measured, not covered.

The liner notes were the hard part. An LLM writing music trivia lies fluently. So there's an eval suite: 19 prompts, a judge that checks every claim against the catalog data the model saw, and a deterministic gate that bounces cards claiming an album opener that isn't one. Invented facts went from 24% of notes to under 6%, and the number is on a dashboard, not in a vibe.

Most of the code was written by Claude Code inside a spec → implement → review loop, with a permission tier that keeps it away from credentials and eval thresholds. I'll write that up separately.

It makes a dozen tapes a day. When they're gone, they're gone. Tell me the mood that broke it.
```

## Draft B — Hebrew

```
בניתי מכונת מיקסטייפים. אומרים את המצב רוח, מקבלים פלייליסט אמיתי בספוטיפיי.

"יום ראשון גשום, קפה, רגוע" ← שמונה שירים שהולכים ביחד, בסדר הנכון, עם שורה על כל אחד למה הוא שם ← לחיצה אחת והוא אצלכם בספוטיפיי. בלי התחברות, בלי הרשמה.

← mixtape-poc-production.up.railway.app

החלק שבאמת מעניין אותי נמצא מתחת.

כל שיר מאומת מול ספוטיפיי לפני שאתם רואים אותו. המודל יכול להוסיף שיר רק אם הוא מצטט מזהה שקיבל מתוצאת חיפוש אמיתית, אז הוא לא יכול להמציא שיר. כשהוא מנסה, הכרטיס כותב "לא מאומת" במקום להסתיר. הזיות מודדים, לא מטשטשים.

ה-liner notes היו החלק הקשה. מודל שפה שכותב טריוויה מוזיקלית משקר בשטף. אז יש מערכת evals: תשעה עשר פרומפטים, שופט שבודק כל טענה מול נתוני הקטלוג שהמודל ראה, ושער דטרמיניסטי שמחזיר כרטיס שטוען ששיר פותח אלבום כשהוא לא. עובדות מומצאות ירדו מ-24% מההערות לפחות מ-6%, והמספר הזה יושב בדשבורד, לא בתחושת בטן.

את רוב הקוד כתב Claude Code בתוך לולאה של spec ← implement ← review, עם שכבת הרשאות ששומרת אותו רחוק מסודות ומספי ה-evals. על זה אכתוב בנפרד.

המכונה מייצרת תריסר קלטות ביום. כשהן נגמרות, נגמרו. ספרו לי איזה מצב רוח שבר אותה.
```

Alternative for "הזיות מודדים, לא מטשטשים": "המצאות מודדים, לא מסתירים."

## Still open on launch day (Nadav's, not the post's)

- Railway variables `RAILWAY_DEPLOYMENT_DRAINING_SECONDS=30` and
  `SESSION_SECRET=<long random>` — set before posting (each triggers a
  redeploy).
- Railway trial ends ~2026-09-14; deferred on purpose until traffic is seen.
- Phone walk from LinkedIn's in-app browser (doubles as the video).
- Post Inspector the night before.

## Where to look

`README.md` (promise, "does the card lie?" section) · `server/curator.ts`
(system prompt, schema, grounding gate) · `docs/decisions/` (three ADRs) ·
`evals/runs/2026-08-31T07-39-24-499Z/summary.json` (the numbers) ·
`docs/factory/plan.md` (the factory) · `client/public/og.png` (the preview).
