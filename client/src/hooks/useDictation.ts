import {
  useEffect,
  useRef,
  useState,
  type MouseEvent as ReactMouseEvent,
  type PointerEvent as ReactPointerEvent,
} from "react";

// Voice input for the prompt box: hold-to-talk, tap-to-lock, the keyboard
// toggle, resuming a take the engine ended on its own, and the mic-blocked
// hint. Dictation appends to whatever is already typed. The prompt, the
// hint, the live region and the textarea's focus stay App's and arrive as
// arguments; `micHandlers` is what MicButton wires, and `stop` is what
// generate calls so pressing it mid-take ends the take.

// Web Speech API — prefixed in Chrome/Safari, absent in Firefox.
// The mic button only renders when the browser can actually transcribe.
const SpeechRecognitionImpl =
  typeof window !== "undefined"
    ? window.SpeechRecognition || window.webkitSpeechRecognition
    : null;

// Once a browser has stored a "deny" for the mic, recognition fails the
// instant it starts and no web page can reopen the permission prompt — the
// only way back is the browser's own site settings, which live somewhere
// different on every platform. Spell out the path for this one.
const MIC_UNBLOCK_STEPS = (() => {
  const ua = typeof navigator !== "undefined" ? navigator.userAgent : "";
  if (/iPhone|iPad|iPod/.test(ua))
    return (
      "tap the ᴀA button in the address bar → Website Settings → " +
      "Microphone → Allow. Dictation itself must also be on: " +
      "iOS Settings → General → Keyboard → Enable Dictation."
    );
  if (/Android/.test(ua))
    return (
      "tap the icon left of the address bar → Permissions → " +
      "Microphone → Allow, then reload."
    );
  if (/Macintosh/.test(ua) && /Safari/.test(ua) && !/Chrome/.test(ua))
    return (
      "open the Safari menu → Settings for This Website → " +
      "Microphone → Allow."
    );
  return (
    "click the icon left of the address bar → Site settings → " +
    "Microphone → Allow, then reload."
  );
})();

// WhatsApp-style push-to-talk: hold the mic to record, let go to stop.
// A quick tap (released before the hold threshold) "locks" the mic on
// instead — hands-free for long prompts — and the next tap stops it.
const HOLD_MS = 400;

export default function useDictation({
  prompt,
  setPrompt,
  setHint,
  announce,
  focusPrompt,
}: {
  prompt: string;
  setPrompt: (value: string) => void;
  setHint: (hint: string | null) => void;
  announce: (line: string) => void;
  focusPrompt: () => void;
}) {
  // voice input — dictation appends to whatever is already typed
  const [listening, setListening] = useState(false);
  const recogRef = useRef<SpeechRecognition | null>(null);
  const dictatingRef = useRef(false); // user intent: mic toggled on
  const dictationBaseRef = useRef(""); // text that precedes this session's speech
  const dictatedRef = useRef(""); // latest composed text, for restart folding
  const holdStartRef = useRef(0);

  // a page-leave mid-dictation must not leave the mic hot
  useEffect(
    () => () => {
      dictatingRef.current = false;
      recogRef.current?.abort();
    },
    []
  );

  // The engine ends a session on its own — after a pause in speech, or at
  // Chrome's session-length cap. dictatingRef holds the user's intent
  // ("the mic button is on"), so onend can tell an engine timeout apart
  // from a deliberate stop and reopen the mic mid-take.
  const startRecognition = () => {
    // only reachable through the mic button, which renders (and wires these
    // handlers) only when SpeechRecognitionImpl exists
    const Recognition = SpeechRecognitionImpl;
    if (!Recognition) return;
    const recog = new Recognition();
    // one language per session is a Web Speech limitation; the browser's
    // own locale is the best single guess we have
    recog.lang = navigator.language || "en-US";
    recog.interimResults = true; // words land in the box as they're spoken
    recog.continuous = true; // a pause for thought must not end the take
    recog.onresult = (e) => {
      const heard = Array.from(e.results)
        .map((r) => {
          // every result carries at least one alternative; the guard is
          // for the type, not a case the engine produces
          const best = r[0];
          return best ? best.transcript : "";
        })
        .join("");
      const composed = dictationBaseRef.current + heard;
      dictatedRef.current = composed;
      setPrompt(composed);
      setHint(null);
    };
    recog.onerror = (e) => {
      if (e.error === "not-allowed" || e.error === "service-not-allowed") {
        dictatingRef.current = false;
        setHint(`The mic is blocked for this site — ${MIC_UNBLOCK_STEPS}`);
      } else if (e.error !== "aborted" && e.error !== "no-speech") {
        // real failure (network, audio-capture) — don't restart-loop on it
        dictatingRef.current = false;
        setHint("Couldn’t catch that — try again, or just type.");
      }
    };
    recog.onend = () => {
      if (dictatingRef.current) {
        // engine gave up but the user never tapped stop — resume the take,
        // folding what's already transcribed into the new session's base
        dictationBaseRef.current = dictatedRef.current.trim()
          ? dictatedRef.current.replace(/\s+$/, "") + " "
          : "";
        startRecognition();
        return;
      }
      recogRef.current = null;
      setListening(false);
      focusPrompt();
    };
    recogRef.current = recog;
    recog.start();
  };

  const stopDictation = () => {
    dictatingRef.current = false;
    recogRef.current?.stop();
  };

  const startDictation = () => {
    dictatingRef.current = true;
    dictationBaseRef.current = prompt.trim()
      ? prompt.replace(/\s+$/, "") + " "
      : "";
    dictatedRef.current = prompt;
    setListening(true);
    announce("Listening. Speak your prompt.");
    startRecognition();
  };

  const micPress = (e: ReactPointerEvent<HTMLButtonElement>) => {
    // capture the pointer so the release fires here even if the finger
    // drifts off the button mid-hold
    e.currentTarget.setPointerCapture?.(e.pointerId);
    e.preventDefault();
    if (recogRef.current) {
      stopDictation(); // mic was locked on by a quick tap — this tap ends it
      holdStartRef.current = 0;
      return;
    }
    holdStartRef.current = e.timeStamp;
    startDictation();
  };

  const micRelease = (e: ReactPointerEvent<HTMLButtonElement>) => {
    if (!recogRef.current || !holdStartRef.current) return;
    if (e.timeStamp - holdStartRef.current < HOLD_MS) return; // quick tap: lock on
    stopDictation();
  };

  // keyboard can't hold-to-talk; Enter/Space toggles (a keyboard-sourced
  // click has detail 0, pointer clicks were already handled above)
  const micKeyToggle = (e: ReactMouseEvent<HTMLButtonElement>) => {
    if (e.detail !== 0) return;
    if (recogRef.current) stopDictation();
    else startDictation();
  };

  return {
    supported: Boolean(SpeechRecognitionImpl),
    listening,
    stop: stopDictation,
    micHandlers: { press: micPress, release: micRelease, keyToggle: micKeyToggle },
  };
}
