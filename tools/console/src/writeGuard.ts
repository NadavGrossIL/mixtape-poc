// Who is allowed to POST /api/file — the console's one write.
//
// Why this exists. The write used to accept any request that reached the port.
// A JSON string body sent as `text/plain` is a CORS-*simple* request: no
// preflight, and the attacker page never needs to read the (opaque) response,
// because by then the write has landed. So while `npm run console` was running,
// any page the owner happened to have open in the same browser could create or
// replace `.claude/workflows/*.js`, `.claude/skills/*/SKILL.md`,
// `.claude/agents/*.md` or `factory.config.json` — exactly the scripts and
// agent prompts the factory hands to Claude Code. The sha256 `base` check is
// not a defence here: it only blocks an overwrite whose current content the
// attacker cannot guess, and every one of those files is tracked, so publishing
// this repo makes the hashes public and the brake disappears.
//
// Two locks, each sufficient on its own, so a mistake in one is not the whole
// fence:
//
//  1. `Origin` must be present AND be one of this dev server's own. Requiring
//     it (rather than waving through a missing header) is deliberate: a browser
//     sets `Origin` on every POST, same-origin included — per Fetch, any method
//     other than GET/HEAD gets one — so a request with no `Origin` is never a
//     browser performing the cross-origin form/fetch write we are defending
//     against. It is curl, or a script. The only client this endpoint has is
//     the console's own page, which always sends the header, so requiring it
//     costs the real client nothing and is strictly the stronger rule.
//
//  2. `content-type` must be `application/json`. That single requirement takes
//     the request out of the CORS-simple set and forces a preflight, which a
//     cross-origin page cannot pass: the API sends no
//     `Access-Control-Allow-Origin` header at all.
//
// Pure and dependency-free, like src/allow.ts, so `node --test` holds the whole
// decision (src/writeGuard.test.ts) and the middleware in plugin.ts only
// applies the verdict.

/**
 * The origins the console's own page can be served from.
 *
 * `vite.config.ts` pins `server: { host: '127.0.0.1', port: 5174, strictPort:
 * true }` and the README documents `http://127.0.0.1:5174`, so that is the
 * canonical one. `http://localhost:5174` is accepted as well, and it is not a
 * wider door: `localhost` resolves to 127.0.0.1, so the only way a page can
 * carry that `Origin` is to have been served by *this* server — it is the same
 * page under the name a browser autocompletes. Anything else (another port,
 * another host, `null` from a sandboxed frame) is refused.
 */
export const WRITE_ORIGINS: readonly string[] = ['http://127.0.0.1:5174', 'http://localhost:5174']

export type WriteVerdict = { ok: true } | { ok: false; status: number; error: string }

type Headers = Record<string, string | string[] | undefined>

/** One header, case-insensitively; the first value when Node handed us a list. */
function header(headers: Headers, name: string): string | undefined {
  const want = name.toLowerCase()
  for (const key of Object.keys(headers ?? {})) {
    if (key.toLowerCase() !== want) continue
    const v = headers[key]
    const s = Array.isArray(v) ? v[0] : v
    return typeof s === 'string' ? s : undefined
  }
  return undefined
}

/**
 * May this request write? `{ ok: true }`, or the status and message the caller
 * should reply with: 403 for the wrong (or absent) `Origin`, 415 for a body
 * that is not declared JSON — the honest status for a media type we refuse.
 *
 * The `content-type` may carry parameters (`application/json; charset=utf-8` is
 * what `fetch` sends when the page sets the bare type), so only the type itself
 * is compared, lowercased.
 */
export function checkWriteRequest(headers: Headers): WriteVerdict {
  const origin = header(headers, 'origin')?.trim()
  if (!origin) return { ok: false, status: 403, error: 'missing Origin header (this endpoint is for the console page only)' }
  if (!WRITE_ORIGINS.includes(origin)) return { ok: false, status: 403, error: 'origin not allowed' }
  const type = header(headers, 'content-type')?.split(';')[0].trim().toLowerCase()
  if (type !== 'application/json') return { ok: false, status: 415, error: 'expected content-type: application/json' }
  return { ok: true }
}
