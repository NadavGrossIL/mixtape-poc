import { type MouseEvent, type PointerEvent } from "react";

// The composer's mic button. The hold-to-talk and tap-to-lock logic lives
// with the dictation state in hooks/useDictation.ts; this is only the button
// and its icon.
export interface MicHandlers {
  press: (e: PointerEvent<HTMLButtonElement>) => void;
  release: (e: PointerEvent<HTMLButtonElement>) => void;
  keyToggle: (e: MouseEvent<HTMLButtonElement>) => void;
}

export default function MicButton({
  listening,
  handlers,
}: {
  listening: boolean;
  handlers: MicHandlers;
}) {
  return (
    <button
      type="button"
      onPointerDown={handlers.press}
      onPointerUp={handlers.release}
      onPointerCancel={handlers.release}
      onClick={handlers.keyToggle}
      onContextMenu={(e) => e.preventDefault()}
      className={"mic-btn" + (listening ? " mic-live" : "")}
      aria-pressed={listening}
      aria-label={
        listening
          ? "Stop voice input"
          : "Hold to talk, or tap to keep the mic on"
      }
      title={
        listening
          ? "Stop voice input"
          : "Hold to talk · tap to keep the mic on"
      }
    >
      <svg
        width="18"
        height="18"
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        strokeWidth="2"
        strokeLinecap="round"
        aria-hidden
      >
        <rect
          x="9"
          y="2"
          width="6"
          height="12"
          rx="3"
          fill="currentColor"
          stroke="none"
        />
        <path d="M5 11a7 7 0 0 0 14 0" />
        <line x1="12" y1="18" x2="12" y2="22" />
      </svg>
    </button>
  );
}
