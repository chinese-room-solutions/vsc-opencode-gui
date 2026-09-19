import { useEffect, useRef, useState } from "preact/hooks";

// Inline rename field shared by the tab bar and Home's
// rows: Enter commits the trimmed text (no-op when empty or unchanged),
// Escape/blur cancel. Focus+select happens once on mount — a function ref
// re-runs on every render, so selecting there re-selected all text on each
// keystroke and the next character replaced it.
export function RenameInput(props: {
  class: string;
  title: string;
  onCommit: (title: string) => void;
  onCancel: () => void;
}) {
  const [value, setValue] = useState(props.title);
  const field = useRef<HTMLInputElement>(null);
  useEffect(() => {
    field.current?.focus();
    field.current?.select();
  }, []);
  const commit = () => {
    props.onCancel();
    const title = value.trim();
    if (title && title !== props.title) props.onCommit(title);
  };
  return (
    <input
      class={props.class}
      value={value}
      onInput={(e) => setValue((e.target as HTMLInputElement).value)}
      onKeyDown={(e) => {
        // Keys stop here: containers bind Enter/Space as activation, which
        // would eat spaces mid-name (and navigate the tab mid-edit).
        e.stopPropagation();
        if (e.key === "Enter") commit();
        else if (e.key === "Escape") props.onCancel();
      }}
      onBlur={props.onCancel}
      ref={field}
    />
  );
}
