import { type RefObject } from "react";

// The shared `.error` block under generate, refine and save: the line, the
// server's own words under it when there are any, and the booked style for
// a cap. With `alertRef` it is focusable (tabIndex -1), so App's effects can
// scroll it into view and focus it.
export default function ErrorAlert({
  message,
  detail,
  booked,
  alertRef,
}: {
  message: string;
  detail?: string | null;
  booked: boolean;
  alertRef?: RefObject<HTMLDivElement>;
}) {
  return (
    <div
      className={"error" + (booked ? " booked" : "")}
      role="alert"
      tabIndex={alertRef ? -1 : undefined}
      ref={alertRef}
    >
      {message}
      {detail && <span className="error-detail">{detail}</span>}
    </div>
  );
}
