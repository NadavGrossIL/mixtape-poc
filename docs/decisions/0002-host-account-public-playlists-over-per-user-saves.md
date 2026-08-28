# ADR 0002 — Public playlists on a host account, not per-user saves

**Status:** accepted · **Date:** 2026-08-28 (`4385a75`, `e21861b`)

## Context

Spotify caps dev-mode apps at 5 allowlisted accounts, permanently; extended
quota is business-only. "Sign in with Spotify" therefore can never be the
way in for the public (`docs/reviews/2026-08-14-architecture-review.md`
framed the whole product around this). A playlist link only opens if the
playlist is public — there is no "unlisted".

## Decision

Every mixtape is pressed into a dedicated **Mixtape host account**
(`SPOTIFY_HOST_REFRESH_TOKEN`, owner fallback) as a *public* playlist; the
visitor keeps it with one tap (**Open in Spotify → +**). Guests never log
in: a signed `anon:` cookie identifies them and the daily caps
(`server/caps.ts`) are the protection, so `APP_SECRET` became optional.
The 5 allowlisted accounts still connect their own Spotify and get a 0-tap
follow into their library — the same code path, a different id.

## Consequences

- The prompt is never written to the playlist (public profile); only the
  curator's title, sanitized.
- Never delete or privatize a pressed playlist: both revoke it from every
  library it was saved to.
- `GUEST_TOTAL_DAILY_CAP` is sized to the Spotify search quota (~12/day),
  not to the bill; cap refusals read as scarcity, not errors.
- Spotify's own suggested alternative ("link to a playlist where the user
  can follow it manually"); setlist.fm's bot works the same way.

Sources: README "Sharing"; commits `4385a75`, `e21861b`.
