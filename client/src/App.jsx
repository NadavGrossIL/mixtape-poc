import { useEffect, useState } from "react";

// ── design tokens ────────────────────────────────────────────
// Studio-dark chrome around a paper "liner notes" insert.
// Display: Archivo Black · Data: Space Mono · Notes: Georgia italic
const ACCENTS = {
  crimson: "#C1272D",
  cobalt: "#1F4BC7",
  forest: "#1D6A43",
  tangerine: "#E36414",
  violet: "#5F3DC4",
  gold: "#B8860B",
};

const FONT_CSS = `
@import url('https://fonts.googleapis.com/css2?family=Archivo+Black&family=Space+Mono:ital,wght@0,400;0,700;1,400&family=Space+Grotesk:wght@400;500;700&display=swap');
`;

const EXAMPLES = [
  "fastest rap verses ever recorded — Rap God energy",
  "songs that sound like driving home at 2am",
  "hebrew indie that deserves a bigger audience",
  "90s hip-hop for a newborn's first road trip",
];

// Candidate product names — cycle with the tiny dev switcher in the corner.
// Where a slash exists it keeps the orange slash accent.
const BRANDS = ["MADE YOU A MIXTAPE", "DEEP/CUTS", "PROMP/TAPE"];

function BrandText({ text }) {
  const i = text.indexOf("/");
  if (i === -1) return <>{text}</>;
  return (
    <>
      {text.slice(0, i)}
      <span style={{ color: "#E36414" }}>/</span>
      {text.slice(i + 1)}
    </>
  );
}

export default function LinerNotes() {
  const [prompt, setPrompt] = useState("");
  const [card, setCard] = useState(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(null);
  const [loggedIn, setLoggedIn] = useState(null); // null = checking
  const [brandIdx, setBrandIdx] = useState(0);
  const [saving, setSaving] = useState(false);
  const [playlistUrl, setPlaylistUrl] = useState(null);
  const [saveError, setSaveError] = useState(null);

  const brand = BRANDS[brandIdx];

  useEffect(() => {
    fetch("/auth/status")
      .then((r) => r.json())
      .then((d) => setLoggedIn(Boolean(d.loggedIn)))
      .catch(() => setLoggedIn(false));
  }, []);

  const generate = async (p) => {
    const thePrompt = (p ?? prompt).trim();
    if (!thePrompt || loading) return;
    setLoading(true);
    setError(null);
    setCard(null);
    setPlaylistUrl(null);
    setSaveError(null);
    try {
      const response = await fetch("/api/generate", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ prompt: thePrompt }),
      });
      const data = await response.json();
      if (!response.ok) throw new Error(data.error || "generate failed");
      if (!data.tracks?.length) throw new Error("empty");
      setCard(data);
    } catch (e) {
      console.error(e);
      setError("The curator dropped the needle. Try the same prompt again.");
    } finally {
      setLoading(false);
    }
  };

  const saveToSpotify = async () => {
    if (!card || saving) return;
    const uris = card.tracks.filter((t) => t.resolved).map((t) => t.spotifyUri);
    if (!uris.length) {
      setSaveError("No verified tracks to save.");
      return;
    }
    setSaving(true);
    setSaveError(null);
    try {
      const response = await fetch("/api/playlist", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ title: card.title, uris, prompt: card.prompt }),
      });
      const data = await response.json();
      if (!response.ok) throw new Error(data.error || "save failed");
      setPlaylistUrl(data.playlistUrl);
    } catch (e) {
      console.error(e);
      setSaveError("Couldn't press it to Spotify. Try again.");
    } finally {
      setSaving(false);
    }
  };

  const accent = card ? ACCENTS[card.accent] || ACCENTS.crimson : ACCENTS.crimson;

  const spotifySearch = (t) =>
    `https://open.spotify.com/search/${encodeURIComponent(t.artist + " " + t.title)}`;

  return (
    <div style={styles.app}>
      <style>{FONT_CSS}</style>

      {/* header */}
      <div style={styles.header}>
        <div style={styles.wordmark}>
          <BrandText text={brand} />
        </div>
        <div style={styles.tagline}>one prompt in. a record sleeve out.</div>
      </div>

      {/* login gate */}
      {loggedIn === false && (
        <a href="/auth/login" style={styles.connectButton}>
          CONNECT SPOTIFY
        </a>
      )}

      {loggedIn === true && (
        <>
          {/* input */}
          <div style={styles.inputRow}>
            <textarea
              value={prompt}
              onChange={(e) => setPrompt(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter" && !e.shiftKey) {
                  e.preventDefault();
                  generate();
                }
              }}
              placeholder="describe the playlist you can hear in your head…"
              rows={2}
              style={styles.input}
              aria-label="Playlist prompt"
            />
            <button
              onClick={() => generate()}
              disabled={loading || !prompt.trim()}
              style={{
                ...styles.button,
                opacity: loading || !prompt.trim() ? 0.4 : 1,
                cursor: loading || !prompt.trim() ? "default" : "pointer",
              }}
            >
              {loading ? "PRESSING…" : "PRESS IT"}
            </button>
          </div>

          {/* example chips */}
          {!card && !loading && (
            <div style={styles.chips}>
              {EXAMPLES.map((ex) => (
                <button
                  key={ex}
                  style={styles.chip}
                  onClick={() => {
                    setPrompt(ex);
                    generate(ex);
                  }}
                >
                  {ex}
                </button>
              ))}
            </div>
          )}
        </>
      )}

      {loading && (
        <div style={styles.loading}>
          <div style={styles.spinnerDisc} />
          <div style={{ fontFamily: "'Space Mono', monospace", fontSize: 13 }}>
            digging through the crates…
          </div>
        </div>
      )}

      {error && <div style={styles.error}>{error}</div>}

      {/* the card */}
      {card && (
        <div style={styles.cardWrap}>
          <div style={styles.card}>
            {/* spine */}
            <div style={{ ...styles.spine, background: accent }}>
              <span style={styles.spineText}>{card.title.toUpperCase()}</span>
            </div>

            <div style={styles.cardBody}>
              <div style={styles.eyebrow}>
                SIDE A · {card.tracks.length} TRACKS · CUT{" "}
                {new Date().toLocaleDateString("en-GB", {
                  day: "2-digit",
                  month: "short",
                  year: "2-digit",
                }).toUpperCase()}
              </div>
              <h1 style={styles.cardTitle}>{card.title}</h1>
              <div style={{ ...styles.vibe, borderColor: accent }}>
                “{card.vibe}”
              </div>
              <div style={styles.promptLine}>
                prompted: <em>{card.prompt}</em>
              </div>

              <div style={styles.trackList}>
                {card.tracks.map((t, i) => (
                  <a
                    key={i}
                    href={t.resolved && t.spotifyUrl ? t.spotifyUrl : spotifySearch(t)}
                    target="_blank"
                    rel="noreferrer"
                    style={styles.trackRow}
                  >
                    {t.resolved && t.albumArt ? (
                      <img src={t.albumArt} alt="" style={styles.albumArt} />
                    ) : (
                      <div style={styles.albumArtPlaceholder} />
                    )}
                    <div style={{ ...styles.trackNum, color: accent }}>
                      {String(i + 1).padStart(2, "0")}
                    </div>
                    <div style={{ flex: 1, minWidth: 0 }}>
                      <div style={styles.trackTitle}>
                        {t.artist} — {t.title}
                      </div>
                      <div style={styles.trackNote}>{t.note}</div>
                    </div>
                    {t.resolved ? (
                      <div style={styles.playHint}>▸</div>
                    ) : (
                      <div style={styles.unverified}>unverified</div>
                    )}
                  </a>
                ))}
              </div>

              <div style={styles.footer}>
                <span>tap a track to open it in Spotify</span>
                <span style={{ fontWeight: 700 }}>
                  <BrandText text={brand} />
                </span>
              </div>
            </div>
          </div>

          {/* save to spotify */}
          {!playlistUrl && (
            <button
              onClick={saveToSpotify}
              disabled={saving}
              style={{
                ...styles.saveButton,
                opacity: saving ? 0.4 : 1,
                cursor: saving ? "default" : "pointer",
              }}
            >
              {saving ? "PRESSING TO WAX…" : "SAVE TO SPOTIFY"}
            </button>
          )}
          {playlistUrl && (
            <a
              href={playlistUrl}
              target="_blank"
              rel="noreferrer"
              style={styles.playlistLink}
            >
              pressed. open in Spotify ▸
            </a>
          )}
          {saveError && <div style={styles.error}>{saveError}</div>}

          <button
            onClick={() => {
              setCard(null);
              setPrompt("");
              setPlaylistUrl(null);
              setSaveError(null);
            }}
            style={styles.again}
          >
            press another one
          </button>
        </div>
      )}

      {/* dev-only wordmark switcher — the product name is undecided */}
      {import.meta.env.DEV && (
        <button
          style={styles.brandSwitcher}
          onClick={() => setBrandIdx((i) => (i + 1) % BRANDS.length)}
          title="cycle candidate wordmarks (dev only)"
        >
          wordmark {brandIdx + 1}/{BRANDS.length}
        </button>
      )}
    </div>
  );
}

// ── styles ───────────────────────────────────────────────────
const styles = {
  app: {
    minHeight: "100vh",
    background: "#191714",
    color: "#EDE8DE",
    fontFamily: "'Space Grotesk', sans-serif",
    padding: "28px 16px 64px",
    display: "flex",
    flexDirection: "column",
    alignItems: "center",
  },
  header: { textAlign: "center", marginBottom: 24 },
  wordmark: {
    fontFamily: "'Archivo Black', sans-serif",
    fontSize: 30,
    letterSpacing: 2,
  },
  tagline: {
    fontFamily: "'Space Mono', monospace",
    fontSize: 12,
    opacity: 0.65,
    marginTop: 6,
  },
  connectButton: {
    fontFamily: "'Archivo Black', sans-serif",
    fontSize: 13,
    letterSpacing: 1,
    background: "#E36414",
    color: "#191714",
    border: "none",
    borderRadius: 4,
    padding: "14px 22px",
    marginTop: 24,
    textDecoration: "none",
    cursor: "pointer",
  },
  inputRow: {
    display: "flex",
    gap: 10,
    width: "100%",
    maxWidth: 560,
    alignItems: "stretch",
  },
  input: {
    flex: 1,
    background: "#211E1A",
    border: "1px solid #3A352E",
    borderRadius: 4,
    color: "#EDE8DE",
    fontFamily: "'Space Grotesk', sans-serif",
    fontSize: 15,
    padding: "12px 14px",
    resize: "none",
    outline: "none",
  },
  button: {
    fontFamily: "'Archivo Black', sans-serif",
    fontSize: 13,
    letterSpacing: 1,
    background: "#E36414",
    color: "#191714",
    border: "none",
    borderRadius: 4,
    padding: "0 18px",
  },
  chips: {
    display: "flex",
    flexWrap: "wrap",
    gap: 8,
    justifyContent: "center",
    maxWidth: 560,
    marginTop: 18,
  },
  chip: {
    fontFamily: "'Space Mono', monospace",
    fontSize: 11.5,
    background: "transparent",
    color: "#B8B0A2",
    border: "1px dashed #4A443B",
    borderRadius: 999,
    padding: "7px 12px",
    cursor: "pointer",
  },
  loading: {
    marginTop: 48,
    display: "flex",
    flexDirection: "column",
    alignItems: "center",
    gap: 16,
    opacity: 0.85,
  },
  spinnerDisc: {
    width: 56,
    height: 56,
    borderRadius: "50%",
    background:
      "repeating-radial-gradient(circle, #0C0B09 0 2px, #26221D 2px 4px)",
    border: "2px solid #E36414",
    animation: "spin 1.4s linear infinite",
  },
  error: {
    marginTop: 32,
    fontFamily: "'Space Mono', monospace",
    fontSize: 13,
    color: "#E36414",
  },
  cardWrap: {
    marginTop: 32,
    width: "100%",
    maxWidth: 560,
    display: "flex",
    flexDirection: "column",
    alignItems: "center",
  },
  card: {
    width: "100%",
    background: "#FAF6EC",
    color: "#14120F",
    display: "flex",
    boxShadow: "0 18px 50px rgba(0,0,0,0.55)",
  },
  spine: {
    width: 34,
    display: "flex",
    alignItems: "center",
    justifyContent: "center",
    flexShrink: 0,
  },
  spineText: {
    writingMode: "vertical-rl",
    transform: "rotate(180deg)",
    fontFamily: "'Archivo Black', sans-serif",
    fontSize: 12,
    letterSpacing: 3,
    color: "#FAF6EC",
    whiteSpace: "nowrap",
    overflow: "hidden",
    maxHeight: "90%",
  },
  cardBody: { padding: "22px 20px 16px", flex: 1, minWidth: 0 },
  eyebrow: {
    fontFamily: "'Space Mono', monospace",
    fontSize: 10,
    letterSpacing: 1.5,
    opacity: 0.55,
  },
  cardTitle: {
    fontFamily: "'Archivo Black', sans-serif",
    fontSize: 28,
    lineHeight: 1.05,
    margin: "8px 0 12px",
  },
  vibe: {
    fontFamily: "Georgia, serif",
    fontStyle: "italic",
    fontSize: 15,
    borderLeft: "3px solid",
    paddingLeft: 12,
    marginBottom: 8,
  },
  promptLine: {
    fontFamily: "'Space Mono', monospace",
    fontSize: 11,
    opacity: 0.55,
    marginBottom: 18,
  },
  trackList: { display: "flex", flexDirection: "column" },
  trackRow: {
    display: "flex",
    gap: 12,
    alignItems: "center",
    padding: "10px 0",
    borderTop: "1px solid #E2DACA",
    textDecoration: "none",
    color: "#14120F",
  },
  albumArt: {
    width: 40,
    height: 40,
    objectFit: "cover",
    flexShrink: 0,
    display: "block",
  },
  albumArtPlaceholder: {
    width: 40,
    height: 40,
    flexShrink: 0,
    background: "#EFE9DA",
    border: "1px dashed #D8CFBB",
    boxSizing: "border-box",
  },
  trackNum: {
    fontFamily: "'Space Mono', monospace",
    fontSize: 13,
    fontWeight: 700,
    width: 22,
    flexShrink: 0,
  },
  trackTitle: {
    fontFamily: "'Space Grotesk', sans-serif",
    fontWeight: 700,
    fontSize: 14.5,
  },
  trackNote: {
    fontFamily: "Georgia, serif",
    fontStyle: "italic",
    fontSize: 12.5,
    opacity: 0.75,
    marginTop: 2,
  },
  playHint: { fontSize: 12, opacity: 0.4, flexShrink: 0 },
  unverified: {
    fontFamily: "'Space Mono', monospace",
    fontSize: 9.5,
    letterSpacing: 1,
    opacity: 0.45,
    flexShrink: 0,
  },
  saveButton: {
    marginTop: 20,
    fontFamily: "'Archivo Black', sans-serif",
    fontSize: 13,
    letterSpacing: 1,
    background: "#E36414",
    color: "#191714",
    border: "none",
    borderRadius: 4,
    padding: "12px 22px",
  },
  playlistLink: {
    marginTop: 20,
    fontFamily: "'Space Mono', monospace",
    fontSize: 13,
    color: "#E36414",
    textDecoration: "none",
    border: "1px solid #E36414",
    borderRadius: 4,
    padding: "10px 16px",
  },
  brandSwitcher: {
    position: "fixed",
    bottom: 10,
    right: 10,
    fontFamily: "'Space Mono', monospace",
    fontSize: 10,
    background: "transparent",
    color: "#6B6459",
    border: "1px dashed #3A352E",
    borderRadius: 3,
    padding: "4px 8px",
    cursor: "pointer",
  },
  again: {
    marginTop: 20,
    fontFamily: "'Space Mono', monospace",
    fontSize: 12,
    background: "transparent",
    color: "#B8B0A2",
    border: "1px solid #4A443B",
    borderRadius: 4,
    padding: "9px 16px",
    cursor: "pointer",
  },
};

// keyframes injected once
if (typeof document !== "undefined" && !document.getElementById("ln-spin")) {
  const s = document.createElement("style");
  s.id = "ln-spin";
  s.textContent = "@keyframes spin { to { transform: rotate(360deg); } }";
  document.head.appendChild(s);
}
