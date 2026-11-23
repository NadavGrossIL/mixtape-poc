// Product analytics: what visitors click and do, via PostHog.
//
// server/metrics.ts already counts the funnel server-side, and it stays the
// source of truth — it sees every visitor, ad blocker or not. This adds what
// the server can't see: clicks, where people came from (referrer, UTM),
// device, the path one visitor took, and session replay.
//
// Off unless VITE_POSTHOG_KEY is set at build time (Railway service
// variables reach the build), and off in `vite dev` unless
// VITE_POSTHOG_DEV=1, so local work never pollutes the numbers. Off, every
// call here is a no-op and posthog-js is never downloaded.
//
// Privacy, on purpose:
// - cookieless_mode "always": no cookie, no localStorage, no sessionStorage;
//   PostHog derives a daily anonymous id from a server-side hash. That is
//   why there is no consent banner. It ONLY works once "cookieless server
//   hash mode" is switched on in the PostHog project settings — otherwise
//   PostHog drops these events.
// - every input is masked in replay, and no event carries prompt text —
//   the same line the playlist description draws (useSave.ts): a prompt can
//   be more personal than the visitor meant it to be.
// - the owner's own visits are never sent: App starts this only once
//   /auth/status has said who is looking, and not at all for the owner.
//
// The "no-external" bundle ships the recorder inside our own chunk, so
// PostHog never injects a script from its CDN and script-src stays 'self';
// connect-src in server/index.ts admits the ingestion host.

type Props = Record<string, string | number | boolean | null>;

type PostHogLike = { capture: (event: string, props?: Props) => void };

const KEY: string | undefined = import.meta.env.VITE_POSTHOG_KEY;
const HOST: string = import.meta.env.VITE_POSTHOG_HOST || "https://eu.i.posthog.com";
const ENABLED = Boolean(KEY) && (!import.meta.env.DEV || import.meta.env.VITE_POSTHOG_DEV === "1");

let client: PostHogLike | null = null;
let started = false;
let off = !ENABLED;
// events fired before the lazy chunk lands; bounded so a blocked load
// can't grow it forever
const queue: [string, Props | undefined][] = [];
const QUEUE_MAX = 50;

// Called once, after the session check. The owner testing their own app
// shouldn't show up as a visitor, so for them posthog-js is never loaded.
export function startAnalytics({ owner }: { owner: boolean }): void {
  if (off || started || typeof window === "undefined") return;
  started = true;
  if (owner) {
    off = true;
    queue.length = 0;
    return;
  }
  import("posthog-js/dist/module.full.no-external")
    .then(({ default: posthog }) => {
      posthog.init(KEY!, {
        api_host: HOST,
        defaults: "2025-05-24",
        cookieless_mode: "always",
        person_profiles: "identified_only",
        autocapture: true,
        capture_pageview: true,
        capture_pageleave: true,
        respect_dnt: true,
        disable_surveys: true,
        session_recording: { maskAllInputs: true },
      });
      client = posthog as unknown as PostHogLike;
      for (const [event, props] of queue.splice(0)) client.capture(event, props);
    })
    .catch(() => {
      // blocked by an extension or offline — analytics is never worth an error
      off = true;
      queue.length = 0;
    });
}

// One named event. Props are facts about the action (counts, kinds, flags),
// never what the visitor typed.
export function track(event: string, props?: Props): void {
  if (off) return;
  if (client) client.capture(event, props);
  else if (queue.length < QUEUE_MAX) queue.push([event, props]);
}
