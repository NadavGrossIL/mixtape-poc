// The share button's decision, kept out of the DOM so it can be unit-tested
// under Node (no DOM lib here): `share` and `copy` are the browser, injected.

export type ShareOutcome = "shared" | "dismissed" | "copied" | "failed";

export async function shareOrCopy(
  data: { title: string; url: string },
  deps: {
    share?: (d: { title: string; url: string }) => Promise<void>; // navigator.share, bound
    copy: (text: string) => Promise<void>; // clipboard write
  },
): Promise<ShareOutcome> {
  if (deps.share) {
    try {
      await deps.share(data);
      return "shared";
    } catch (e) {
      // The user closed the sheet: that is a choice, not a failure to fall back from.
      if ((e as { name?: unknown } | null)?.name === "AbortError") return "dismissed";
      // Anything else (payload refused, no user gesture): the user asked to
      // share, and a copied link is the nearest thing to that.
    }
  }
  try {
    await deps.copy(data.url);
    return "copied";
  } catch {
    // The clipboard can refuse (permissions, insecure context); the button
    // reports it rather than throwing into React's click handler.
    return "failed";
  }
}
