import { useState } from "react";
import { shareOrCopy, shareUrlFor, type ShareOutcome } from "../share";
import { track } from "../analytics";

// One share control for every place a mixtape can be shared from: the
// pressed card, its share page, and the "your mixtapes" / "fresh off the
// press" rows. It always sends the mixtape's own page (/m/<id>), never the
// bare Spotify link, so the friend sees the card. Native share sheet where
// there is one, else a copied link; the decision lives in share.ts.
//
// The link is either derived from the pressed playlist (`spotifyUrl`) or
// given directly (`url`) — a jam set shared without saving has no playlist,
// so its page link comes from POST /api/share, fetched on the tap: then `url`
// is a function, and null from it means the caller has already shown why.
export default function ShareButton({
  title,
  spotifyUrl,
  url,
  kind,
  where,
  className,
  label = "share",
  ariaLabel,
  announce,
  disabled,
  onOutcome,
}: {
  title: string;
  spotifyUrl?: string;
  url?: string | (() => Promise<string | null>);
  // "set": a jam set shared without saving — rides on the share event
  kind?: "set";
  where: "pressed" | "page" | "recent" | "latest" | "card";
  className: string;
  label?: string;
  ariaLabel?: string;
  announce?: (line: string) => void;
  disabled?: boolean;
  onOutcome?: (outcome: ShareOutcome, url: string) => void;
}) {
  const [copied, setCopied] = useState(false);
  const onShare = async () => {
    const link =
      typeof url === "function"
        ? await url()
        : (url ?? shareUrlFor(spotifyUrl ?? "", window.location.origin));
    if (!link) return;
    const outcome = await shareOrCopy(
      { title, url: link },
      {
        share: navigator.share ? navigator.share.bind(navigator) : undefined,
        copy: (t) => navigator.clipboard.writeText(t),
      },
    );
    track("mixtape_shared", kind ? { outcome, where, kind } : { outcome, where });
    onOutcome?.(outcome, link);
    if (outcome === "copied") {
      setCopied(true);
      announce?.("Link copied.");
      setTimeout(() => setCopied(false), 1800);
    } else if (outcome === "failed") {
      announce?.("Couldn't copy — select it by hand.");
    }
    // "shared" / "dismissed": the sheet was the feedback — nothing to report
  };
  return (
    <button
      type="button"
      className={className}
      aria-label={ariaLabel ?? `Share ${title}`}
      onClick={onShare}
      disabled={disabled}
    >
      {/* the label is the feedback; aria-live so a screen reader hears it */}
      <span aria-live="polite">{copied ? "link copied ✓" : label}</span>
    </button>
  );
}
