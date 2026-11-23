import { useState } from "react";
import { shareOrCopy, shareUrlFor } from "../share";
import { track } from "../analytics";

// One share control for every place a mixtape can be shared from: the
// pressed card, its share page, and the "your mixtapes" / "fresh off the
// press" rows. It always sends the mixtape's own page (/m/<id>), never the
// bare Spotify link, so the friend sees the card. Native share sheet where
// there is one, else a copied link; the decision lives in share.ts.
export default function ShareButton({
  title,
  spotifyUrl,
  where,
  className,
  label = "share",
  ariaLabel,
  announce,
}: {
  title: string;
  spotifyUrl: string;
  where: "pressed" | "page" | "recent" | "latest";
  className: string;
  label?: string;
  ariaLabel?: string;
  announce?: (line: string) => void;
}) {
  const [copied, setCopied] = useState(false);
  const onShare = async () => {
    const url = shareUrlFor(spotifyUrl, window.location.origin);
    const outcome = await shareOrCopy(
      { title, url },
      {
        share: navigator.share ? navigator.share.bind(navigator) : undefined,
        copy: (t) => navigator.clipboard.writeText(t),
      },
    );
    track("mixtape_shared", { outcome, where });
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
    >
      {/* the label is the feedback; aria-live so a screen reader hears it */}
      <span aria-live="polite">{copied ? "link copied ✓" : label}</span>
    </button>
  );
}
