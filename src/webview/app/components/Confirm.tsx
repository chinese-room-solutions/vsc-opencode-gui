// The modal confirm's chrome: a centered backdrop dialog with one
// danger-labelled action and Cancel. A backdrop click or Esc cancels; the
// caller gates visibility and owns the action (a session delete, a project
// purge, the host-driven tab delete).
import { useEffect } from "preact/hooks";

export function Confirm(props: {
  text: preact.ComponentChildren;
  dangerLabel: string;
  onConfirm: () => void;
  onCancel: () => void;
}) {
  // Esc cancels — modal parity — and marks the key claimed so the wider
  // Esc affordances (the child drill-down's back-to-parent) stand down.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.preventDefault();
        props.onCancel();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [props.onCancel]);
  return (
    <div class="confirm-backdrop" onClick={props.onCancel}>
      <div class="confirm" role="dialog" onClick={(e) => e.stopPropagation()}>
        <div class="confirm-text">{props.text}</div>
        <div class="confirm-actions">
          <button class="confirm-danger" onClick={props.onConfirm}>
            {props.dangerLabel}
          </button>
          <button onClick={props.onCancel}>Cancel</button>
        </div>
      </div>
    </div>
  );
}
