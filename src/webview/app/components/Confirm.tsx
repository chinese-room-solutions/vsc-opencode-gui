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
  // The dialog owns the keys while it is up: Esc cancels, Enter runs the
  // danger action (the permission dock commits on Enter the same way).
  // Capture with stopPropagation — focus can sit in the composer under
  // the dialog, whose Enter would otherwise also send the prompt — and
  // preventDefault, so the child drill-down's Esc-to-parent stands down.
  // Enter confirms even from Cancel's focus - default-button semantics.
  // An IME's Enter/Esc commits or drops a candidate, not the dialog.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.isComposing) return;
      if (e.key === "Escape") {
        e.preventDefault();
        e.stopPropagation();
        props.onCancel();
      } else if (e.key === "Enter") {
        e.preventDefault();
        e.stopPropagation();
        props.onConfirm();
      }
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [props.onCancel, props.onConfirm]);
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
