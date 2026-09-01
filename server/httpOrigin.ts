// Is this state-changing request coming from our own page, or from someone
// else's? — as a pure function, so the one bit that decides whether a stranger's
// HTML form can spend the app's Anthropic and Spotify budget is testable
// without a server (ADR 0003).
//
// The hole this closes: nothing here needs an existing session. callerIdentity()
// mints a fresh signed guest cookie for whoever asks, so SameSite=Lax protects
// nothing — there is no logged-in state to ride. And a form POST is a "simple
// request": no preflight, no CORS check, the body lands parsed. So a page on
// evil.example could press playlists into the host account and burn the daily
// caps, all day, from every visitor it had.
//
// The rule is deliberately permissive about ABSENCE and strict about MISMATCH:
//
//   * No Origin at all → allowed. curl, the `hermes/` client (a real first-party
//     consumer of this API), a same-origin GET — none of them send one, and
//     rejecting them would break working callers to stop an attack that does not
//     exist: a browser doing the cross-site POST we care about ALWAYS sends
//     Origin.
//   * Sec-Fetch-Site: same-origin / same-site → allowed even if Origin does not
//     match the Host we computed. Browsers set this header themselves and page
//     script cannot forge it, and it is the honest answer when a reverse proxy
//     rewrites Host to something internal so our own derived origin is wrong.
//   * An Origin we do not recognise → rejected. That is the attack, and it is
//     the only case that 403s.
//
// The allowed set is derived per-request rather than configured: the same build
// runs on localhost, on 127.0.0.1 and on the deployed host, and none of them
// know their own public URL. Host + protocol IS the same-origin answer.

interface OriginInput {
  // the Origin request header, if the client sent one
  origin?: string | null;
  // the Sec-Fetch-Site request header, if the browser sent one
  secFetchSite?: string | null;
  // the Host request header — what the client thinks it is talking to
  host?: string | null;
  // http | https. Callers pass `req.protocol`, which honours X-Forwarded-Proto
  // because `trust proxy` is on, so TLS-terminated deploys compare as https.
  proto?: string | null;
  // extra origins that count as ours — the Vite dev server, mostly
  extraAllowed?: string[];
}

// "https://Example.com:443/x" → "https://example.com" (URL drops the default
// port for the scheme, which is what we want: the browser omits it too).
// Anything that is not a parseable absolute URL is not an origin we can match.
function normalizeOrigin(value: string | null | undefined): string | null {
  const raw = String(value || "").trim();
  if (!raw) return null;
  try {
    const url = new URL(raw);
    if (url.protocol !== "http:" && url.protocol !== "https:") return null;
    return url.origin.toLowerCase();
  } catch {
    return null;
  }
}

const LOOPBACK_HOSTS = new Set(["localhost", "127.0.0.1", "[::1]", "::1"]);

// The dev server is reachable as both http://localhost:5173 and
// http://127.0.0.1:5173, and which one the browser sends depends on which one
// the developer typed. CLIENT_URL only ever names one of them, so accept the
// sibling spelling rather than making the check depend on a habit.
function allowedOriginsFromUrls(urls: (string | null | undefined)[]): string[] {
  const out = new Set<string>();
  for (const url of urls) {
    const origin = normalizeOrigin(url);
    if (!origin) continue;
    out.add(origin);
    try {
      const parsed = new URL(origin);
      if (parsed.hostname === "localhost") {
        parsed.hostname = "127.0.0.1";
        out.add(parsed.origin.toLowerCase());
      } else if (parsed.hostname === "127.0.0.1") {
        parsed.hostname = "localhost";
        out.add(parsed.origin.toLowerCase());
      }
    } catch {
      // normalizeOrigin already parsed it once; nothing to recover here.
    }
  }
  return [...out];
}

// Does this URL point somewhere off this machine? Used to decide whether the
// process is internet-reachable (index.ts, DEPLOYED). Unparseable reads as
// "don't know" → false, because the other DEPLOYED signals are the reliable
// ones and guessing "deployed" off a typo would lock a developer out of their
// own logs.
function isRemoteUrl(value: string | null | undefined): boolean {
  const origin = normalizeOrigin(value);
  if (!origin) return false;
  const hostname = new URL(origin).hostname.toLowerCase();
  if (LOOPBACK_HOSTS.has(hostname)) return false;
  if (hostname.endsWith(".localhost")) return false;
  // 0.0.0.0 is a bind address, not somewhere a browser can reach.
  if (hostname === "0.0.0.0") return false;
  return true;
}

function originAllowed(input: OriginInput): boolean {
  const site = String(input.secFetchSite || "").trim().toLowerCase();
  // The browser's own verdict, unforgeable from page script. Trust it before
  // trying to reconstruct our origin from headers a proxy may have rewritten.
  if (site === "same-origin" || site === "same-site") return true;

  const raw = String(input.origin || "").trim();
  // No Origin header at all — curl, hermes, a top-level navigation. Not the
  // attack we are stopping, and rejecting it breaks working callers.
  if (!raw) return true;
  const origin = normalizeOrigin(raw);
  // Sent, but not a real origin: `Origin: null` is what a sandboxed iframe or a
  // data: URL form sends. That IS a browser, and it is not us.
  if (!origin) return false;

  const host = String(input.host || "").trim();
  const proto =
    String(input.proto || "http").trim().toLowerCase() === "https" ? "https" : "http";
  const allowed = new Set(
    allowedOriginsFromUrls([host ? `${proto}://${host}` : null, ...(input.extraAllowed || [])])
  );
  return allowed.has(origin);
}

export type { OriginInput };
export { originAllowed, normalizeOrigin, allowedOriginsFromUrls, isRemoteUrl };
