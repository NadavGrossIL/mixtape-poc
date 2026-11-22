// What a stranger gets, shown before they spend a minute finding out: the
// proof, placed right under the composer.
//
// The content is a real production run (2026-11-21), trimmed to two rows.
// The notes are the curator's own output, not marketing copy, so the sample
// cannot promise a voice the product doesn't have. Picked from three runs
// for songs a stranger already knows and notes with some wit in them: the
// first sample (a 2am-drive tape of Kavinsky and Washed Out) was accurate
// and gave nobody a reason to want one.
const SAMPLE = {
  prompt: "cooking dinner for someone you like",
  title: "Stovetop Slow Burn",
  vibe: "For nights when the sauce simmers slower than the conversation.",
  total: 8,
  tracks: [
    {
      artist: "Stevie Wonder",
      title: "Signed, Sealed, Delivered (I'm Yours)",
      note: "Motown handclaps that turn chopping onions into a little dance floor.",
    },
    {
      artist: "Sade",
      title: "Smooth Operator",
      note: "Opens 1984's Diamond Life — brass and cool confidence over a simmering pan.",
    },
  ],
};

// Static on purpose: no links, no hover, no drag. It is a picture of the
// result, and a row that reacted to the pointer would read as the result.
// No accent hue either: it is drawn in the wall's own cream line, like the
// cassette in the header, so the one bright paper object on the site is the
// real card.
export default function SampleCard() {
  return (
    <section className="sample" aria-labelledby="sample-heading">
      <div className="section-note" id="sample-heading">
        what you get
      </div>
      <div className="card sample-card">
        <div className="spine">
          <span className="spine-text">{SAMPLE.title.toUpperCase()}</span>
        </div>
        <div className="card-body">
          <div className="prompt-line">
            someone typed: <em>{SAMPLE.prompt}</em>
          </div>
          <div className="card-title sample-title">{SAMPLE.title}</div>
          <div className="vibe">
            “{SAMPLE.vibe}”
          </div>
          <div className="track-list">
            {SAMPLE.tracks.map((t, i) => (
              <div className="sample-row" key={t.title}>
                <div className="track-num">
                  {String(i + 1).padStart(2, "0")}
                </div>
                <div className="track-main">
                  <div className="track-title">
                    {t.artist} — {t.title}
                  </div>
                  <div className="track-note">{t.note}</div>
                </div>
              </div>
            ))}
          </div>
          <div className="sample-more">
            + {SAMPLE.total - SAMPLE.tracks.length} more songs
          </div>
        </div>
      </div>
    </section>
  );
}
