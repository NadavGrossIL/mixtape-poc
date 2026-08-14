// Web Speech API — TypeScript's DOM lib ships the event/result types
// (SpeechRecognitionEvent, SpeechRecognitionErrorEvent, …) but not the
// SpeechRecognition interface itself, nor the window constructors (which are
// webkit-prefixed in Chrome/Safari). Declare only the surface this app uses.

interface SpeechRecognition extends EventTarget {
  lang: string;
  continuous: boolean;
  interimResults: boolean;
  onresult: ((this: SpeechRecognition, ev: SpeechRecognitionEvent) => void) | null;
  onerror:
    | ((this: SpeechRecognition, ev: SpeechRecognitionErrorEvent) => void)
    | null;
  onend: ((this: SpeechRecognition, ev: Event) => void) | null;
  start(): void;
  stop(): void;
  abort(): void;
}

interface Window {
  SpeechRecognition?: new () => SpeechRecognition;
  webkitSpeechRecognition?: new () => SpeechRecognition;
}
