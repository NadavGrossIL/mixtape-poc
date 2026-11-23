import { createRoot } from "react-dom/client";
import App from "./App.tsx";
import SharedMixtape from "./components/SharedMixtape.tsx";
import { sharedIdFrom } from "./share.ts";
import "./styles/index.css";

// One screen, plus the share page (/m/<playlist id>) a shared link lands on.
// No router: that is the only other path, and the server sends index.html
// for it with the mixtape's own link-preview tags (server/shares.ts).
const sharedId = sharedIdFrom(window.location.pathname);

createRoot(document.getElementById("root")!).render(
  sharedId ? <SharedMixtape id={sharedId} /> : <App />,
);
