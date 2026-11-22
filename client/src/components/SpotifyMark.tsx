// The Spotify mark, monochrome via currentColor — Spotify's brand rules allow
// the one-color mark on buttons that link into Spotify. Used ONLY at the
// touchpoints that actually hit Spotify (connect, save, open), never in the
// header: this is Mixtape's page, not Spotify's.
export default function SpotifyMark({ size = 16 }: { size?: number }) {
  return (
    <svg
      className="spotify-mark"
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="currentColor"
      aria-hidden="true"
    >
      <path d="M12 0C5.37 0 0 5.37 0 12s5.37 12 12 12 12-5.37 12-12S18.63 0 12 0zm5.5 17.31a.75.75 0 0 1-1.03.25c-2.82-1.72-6.37-2.11-10.55-1.16a.75.75 0 1 1-.33-1.46c4.57-1.04 8.49-.59 11.66 1.34.35.21.46.67.25 1.03zm1.47-3.27a.94.94 0 0 1-1.29.31c-3.23-1.98-8.15-2.55-11.97-1.4a.94.94 0 1 1-.54-1.79c4.36-1.32 9.79-.68 13.49 1.6.44.27.58.85.31 1.28zm.13-3.4C15.24 8.4 8.94 8.19 5.24 9.31a1.13 1.13 0 1 1-.65-2.16C8.83 5.86 15.88 6.11 20.26 8.7a1.13 1.13 0 0 1-1.16 1.94z" />
    </svg>
  );
}
