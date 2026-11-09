// The session's right-click menu body: the same items wherever a session
// answers right-click (a Navigator row, the chat view). RowMenu supplies
// the chrome; the caller supplies each action — fork's open differs by
// context (a foreign row deep-links its project's window, the chat's
// session is always local).
export function SessionMenuItems(props: {
  id: string;
  onClose: () => void;
  onFork: () => void;
  onRename: () => void;
  onDelete: () => void;
}) {
  return (
    <>
      <button
        class="menu-item"
        role="menuitem"
        onClick={() => {
          props.onClose();
          void navigator.clipboard.writeText(props.id).catch(() => {});
        }}
      >
        Copy Session ID
      </button>
      <div class="menu-sep" role="separator" />
      <button
        class="menu-item"
        role="menuitem"
        onClick={() => {
          props.onClose();
          props.onFork();
        }}
      >
        Fork session
      </button>
      <button
        class="menu-item"
        role="menuitem"
        onClick={() => {
          props.onClose();
          props.onRename();
        }}
      >
        Rename…
      </button>
      <div class="menu-sep" role="separator" />
      <button
        class="menu-item"
        role="menuitem"
        onClick={() => {
          props.onClose();
          props.onDelete();
        }}
      >
        Delete session
      </button>
    </>
  );
}
