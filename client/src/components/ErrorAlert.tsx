import { useEffect, useRef } from "react";
import { bringIntoView } from "../bringIntoView";

// The shared `.error` block under generate, refine and save: the line, the
// server's own words under it when there are any, and the booked style for
// a cap. With `focusKey` it is focusable (tabIndex -1) and scrolls itself
// into view and takes focus whenever the key changes to a non-zero value;
// generate and save pass their failure tick, refine passes nothing.
export default function ErrorAlert({
  message,
  detail,
  booked,
  focusKey,
}: {
  message: string;
  detail?: string | null;
  booked: boolean;
  focusKey?: number;
}) {
  const alertRef = useRef<HTMLDivElement | null>(null);

  // The error renders inside the composer, but a phone that scrolled down to
  // the progress log is still looking below it — the button just snapped
  // from STOP back to MAKE THE MIXTAPE and looked like it did nothing. Pull
  // the alert into view and focus it, so eye and screen reader both land on
  // it. An effect, not a rAF in the catch: it runs after the commit that
  // mounts the element, whichever way React schedules that. A failed save
  // renders its line under the save notes, which a phone scrolled up to the
  // sticky button can't see — same fix.
  //
  // This replaced an effect in App on [errorTick] / [saveErrorTick]. Same
  // trigger: every tick bump sets the message in the same batch, so this
  // alert is mounted on that commit, and either it was just mounted (the
  // run or save start cleared the message) or it was already up and the key
  // changed (a second "No verified songs"); both run this effect. And it
  // never mounts with a non-zero key that didn't just change, because the
  // screen it sits on never unmounts while its message is set: generate's
  // sits on the home screen, which only a card replaces, and the run that
  // makes a card cleared the message first; save's sits under the card,
  // and "make another one" clears it along with the card. Not under
  // StrictMode (main.tsx has none): there a mount runs effects twice and
  // this would scroll twice.
  useEffect(() => {
    const el = alertRef.current;
    if (!focusKey || !el) return;
    bringIntoView(el);
  }, [focusKey]);

  return (
    <div
      className={"error" + (booked ? " booked" : "")}
      role="alert"
      tabIndex={focusKey !== undefined ? -1 : undefined}
      ref={alertRef}
    >
      {message}
      {detail && <span className="error-detail">{detail}</span>}
    </div>
  );
}
