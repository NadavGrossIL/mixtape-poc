import DeckHero from "./DeckHero";
import { BRAND } from "../brand";

// The page header: the wordmark lockup and, until a card is on the table,
// the tagline. `compact` is "a card is on the table".
export default function SiteHeader({ compact }: { compact: boolean }) {
  return (
    <header className="header">
      {/* one cassette, not two, and one lockup, not a picture over a
          title: the animated deck stands beside the wordmark on its
          baseline and its tape underlines the word. Once a card is on
          the table the compact static mark takes over. */}
      <h1 className={compact ? "wordmark" : "wordmark wordmark-lockup"}>
        <DeckHero compact={compact} />
        {BRAND}
      </h1>
      {/* the tagline: one human sentence about the playlist, not a
          process. The line under it answers the three things a stranger
          needs before typing: who picks the songs, what comes back (a
          Spotify playlist — the one thing it does ask of them), and what
          it costs (nothing, and no account here). Both step aside
          once a card is on the table — the pitch has done its job, and
          the height goes to the card and its save button. */}
      {!compact && (
        <>
          <p className="tagline">Say the mood. We’ll make the playlist.</p>
          <p className="tagline-sub">
            An AI picks eight songs for a Spotify playlist. Free, no sign-up.
          </p>
        </>
      )}
    </header>
  );
}
