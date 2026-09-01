# Security

## Reporting a vulnerability

Use GitHub's **private vulnerability reporting** on this repository
(Security → Report a vulnerability). That keeps the details out of public
view until there is a fix.

If private reporting is unavailable to you, open a normal issue — but only
with enough detail to make contact. Do not put a working exploit, a token, or
anyone's account data in a public issue.

## What to expect

This is a personal proof-of-concept, maintained in spare time by one person.
There is no on-call rotation and no service level to promise. Realistically:
a reply within a couple of weeks, and a fix when the maintainer next sits down
with the repo. If that is too slow for your disclosure timeline, say so in the
report and publish on your own schedule — that is a fair thing to do here.

## Scope

In scope: the code in this repository — the Express server in `server/`, the
React client in `client/`, and the deploy guidance in `README.md`. The kinds
of things worth reporting: a way to read another user's Spotify tokens, to
bypass the per-account or per-guest spend caps in `server/caps.ts` and
`server/pressCaps.ts`, to reach the owner-only log panel without the owner's
session, or to get the server to write a file or make a request it should not.

Out of scope: Spotify's and Anthropic's own services (report those to them);
the running instance's hosting provider; anything that requires the
maintainer's own laptop or credentials to begin with; and missing hardening
that costs nothing here because there is nothing behind it — this app stores
no personal data beyond Spotify OAuth tokens for accounts that explicitly
connected, and it takes no payments.

## Known posture

Secrets live only in environment variables and in gitignored files under
`server/` (`.tokens.json`, `.env`). If you ever find one of those committed,
that is a real finding and worth reporting straight away.
