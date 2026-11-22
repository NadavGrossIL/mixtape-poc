// Shared by ErrorAlert (a failure line that just landed) and PressedPanel
// (the OPEN IN SPOTIFY block a save just mounted).
//
// Scroll something that just mounted into view and move focus onto it, so
// eye and screen reader land in the same place. Smooth unless the visitor
// asked for less motion; focus without a second, instant scroll.
export function bringIntoView(scrollTo: HTMLElement, focusOn: HTMLElement = scrollTo) {
  const reduce =
    typeof window.matchMedia === "function" &&
    window.matchMedia("(prefers-reduced-motion: reduce)").matches;
  scrollTo.scrollIntoView({ block: "center", behavior: reduce ? "auto" : "smooth" });
  focusOn.focus({ preventScroll: true });
}
