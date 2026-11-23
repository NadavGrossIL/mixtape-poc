import { useReducer } from "react";
import { type MixCard, type SaveStreamEvent } from "../types";
import { CapError, readSSE } from "../sse";
import { saveRefusal } from "../failures";
import { saveIdle, saveRun } from "../saveRun";
import { track } from "../analytics";

// Pressing the card to a Spotify playlist: the save run (its stage label,
// the pressed playlist, its error and failure tick; saveRun.ts). The card
// stays App's: `save` reads this render's card, and `onSaved` is told the
// title and URL once the playlist exists, so App can remember it on this
// browser and refresh the shelf. Generate and "make another one" call
// `reset`.
export default function useSave({
  card,
  announce,
  onSaved,
  initialPlaylistUrl = null,
  initialSavedToLibrary = false,
}: {
  card: MixCard | null;
  announce: (line: string) => void;
  onSaved: (pressed: { title: string; url: string }) => void;
  // a card restored after Back or a reload that was already pressed
  // (currentCard.ts): its playlist, so it isn't offered for saving again
  initialPlaylistUrl?: string | null;
  initialSavedToLibrary?: boolean;
}) {
  const [state, dispatch] = useReducer(saveRun, {
    ...saveIdle,
    playlistUrl: initialPlaylistUrl,
    savedToLibrary: initialSavedToLibrary,
  });

  const save = async () => {
    if (!card || state.saving) return;
    const uris = card.tracks.filter((t) => t.resolved).map((t) => t.spotifyUri);
    if (!uris.length) {
      dispatch({ type: "failed", error: { message: "No verified songs to save.", booked: false } });
      return;
    }
    dispatch({ type: "started" });
    track("save_requested", { tracks: uris.length });
    try {
      const response = await fetch("/api/playlist", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Accept: "text/event-stream",
        },
        // the vibe line becomes the playlist description; the prompt stays
        // off on purpose: it lands on a public profile, and a prompt can be
        // more personal than intended
        body: JSON.stringify({ title: card.title, vibe: card.vibe, uris }),
      });
      if (!response.ok) {
        const data: { error?: string } = await response.json().catch(() => ({}));
        const refusal = saveRefusal(response.status, data.error);
        if (refusal) throw new CapError(refusal);
        throw new Error(data.error || "save failed");
      }
      // widened initializers: the assignments happen inside the readSSE
      // callback, which TS's control-flow analysis can't see
      let url = null as string | null;
      let saved = false;
      let streamError = null as string | null;
      await readSSE<SaveStreamEvent>(response, (event, data) => {
        if (event === "creating") dispatch({ type: "stage", stage: "CREATING PLAYLIST…" });
        else if (event === "adding") dispatch({ type: "stage", stage: `ADDING ${data?.count} SONGS…` });
        else if (event === "done") {
          url = data?.playlistUrl ?? null;
          saved = Boolean(data?.saved);
        } else if (event === "error") streamError = data?.message || "save failed";
      });
      if (streamError) {
        const refusal = saveRefusal(null, streamError);
        if (refusal) throw new CapError(refusal);
        throw new Error(streamError);
      }
      if (!url) throw new Error("no playlist url");
      announce(
        saved
          ? "Saved. The playlist is in your Spotify library."
          : "Your playlist is ready. Open it in Spotify and tap plus to add it to your library."
      );
      track("playlist_saved", { tracks: uris.length, saved_to_library: saved });
      dispatch({ type: "succeeded", playlistUrl: url, savedToLibrary: saved });
      // remembered here so a guest who didn't tap + can find it again
      onSaved({ title: card.title, url });
    } catch (e) {
      // a cap (today's saves, Spotify's daily quota) is the server's own
      // line: "try again" is wrong advice until tomorrow. Anything else is a
      // fault, and its text is for the log, not the visitor (failures.ts).
      track("save_failed", { capped: e instanceof CapError });
      if (e instanceof CapError) {
        dispatch({ type: "failed", error: { message: e.message, booked: true } });
        announce(e.message);
      } else {
        console.error(e);
        dispatch({
          type: "failed",
          error: { message: "Couldn't save it to Spotify. Try again.", booked: false },
        });
      }
    } finally {
      dispatch({ type: "finished" });
    }
  };

  return {
    saving: state.saving,
    stage: state.stage,
    playlistUrl: state.playlistUrl,
    savedToLibrary: state.savedToLibrary,
    error: state.error,
    errorTick: state.errorTick,
    save,
    reset: () => dispatch({ type: "reset" }),
  };
}
