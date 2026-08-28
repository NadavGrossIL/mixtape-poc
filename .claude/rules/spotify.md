---
paths:
  - "server/spotify.ts"
  - "server/caps.ts"
---

# Spotify, 2026 dev-mode surface

- **5 allowlisted users, permanently.** Extended quota is business-only, so
  "sign in with Spotify" is never the growth path — every public mixtape is
  pressed into the host account instead
  (`docs/decisions/0002-host-account-public-playlists-over-per-user-saves.md`).
  Never delete or privatize a pressed playlist: both revoke it from every
  library that saved it.
- **Dead / renamed endpoints** (header comment in `spotify.ts`):
  `POST /users/{id}/playlists` was removed Feb 2026 → `POST /v1/me/playlists`;
  `/playlists/{id}/tracks` → `/playlists/{id}/items` (body still `uris`).
  Search `limit` max is 10; track objects no longer carry `popularity` or
  `available_markets`.
- **429 is two different things.** Rate limit = rolling 30 s, retry once.
  Quota = `"reason": "QUOTA_EXCEEDED"`, a DAILY per-developer-account
  allowance shared by local dev, Railway and `evals/` — low hundreds of
  requests, ~10–30 curator runs. Measured Retry-After: 69,785 s (19.4 h).
  `classify429` branches on the reason (pure, tested); a quota verdict opens
  the process-wide breaker (`quotaBlockedUntil`) and fails the run. Do not
  add backoff to a quota 429. Quota counts requests, not items — always
  `limit=10`.
- Caps in `caps.ts` are sized to that quota, not to the Anthropic bill
  (`GUEST_TOTAL_DAILY_CAP` ≈ 12 in public mode — README → Sharing).
