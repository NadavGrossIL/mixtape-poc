// The quiet lines at the foot of the home screen: the connect note for the
// allowlisted few, the credit and the logging notice. `showConnect` is "a
// guest, in dev or behind ?debug".
export default function HomeNotes({ showConnect }: { showConnect: boolean }) {
  return (
    <>
      {/* the allowlisted few connect here. It cannot be offered to
          everyone (Spotify caps dev-mode apps at 5 accounts), and
          "5 test accounts" is internal vocabulary on a public page,
          so it only renders in dev or behind ?debug — the same door
          as the log console. The five who have an account know the
          door; a stranger never sees a line that reads as "this is
          a test". The wording stays literal: "on the list?" once
          read like a waitlist and sent strangers into OAuth. */}
      {showConnect && (
        <div className="connect-note">
          already one of the 5 test accounts?{" "}
          <a href="/auth/login" className="connect-link">
            connect your Spotify
          </a>{" "}
          to pick from your own playlists and save in one go
        </div>
      )}

      {/* the credit: the quietest line on the screen, under the
          garnish. A visitor from the post knows who made it; a
          visitor from a shared link doesn't, and this is the one
          backlink to the maker. One name, one link, nothing that
          competes with the composer above it. */}
      <a
        className="credit-line"
        href="https://www.linkedin.com/in/nadavgr/"
        target="_blank"
        rel="noopener noreferrer"
      >
        made by Nadav Gross
      </a>
      {/* the notice: what a visitor types is kept. True today (the
          server log records each prompt) and it is what makes
          turning on LangSmith tracing for visitors an honest thing
          to do (LANGSMITH_TRACE_VISITORS, server/curatorLoader.ts).
          Said once, where the typing happens, as quietly as the
          credit above it. */}
      <div className="notice-line">prompts are logged to help improve Mixtape</div>
    </>
  );
}
