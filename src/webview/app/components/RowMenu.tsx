import { useEffect, useLayoutEffect, useRef, useState } from "preact/hooks";

// A right-click menu's chrome: a .menu at fixed viewport coords (the
// pointer), pulled inside the viewport after first paint. Any click,
// Escape, scroll, resize, or window blur closes it.
export function RowMenu(props: {
  x: number;
  y: number;
  onClose: () => void;
  children?: preact.ComponentChildren;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState({ x: props.x, y: props.y });
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const r = el.getBoundingClientRect();
    setPos({
      x: Math.max(4, Math.min(props.x, window.innerWidth - r.width - 4)),
      y: Math.max(4, Math.min(props.y, window.innerHeight - r.height - 4)),
    });
    // Per mount; the menu unmounts between opens.
  }, []);
  useEffect(() => {
    const close = () => props.onClose();
    const key = (e: KeyboardEvent) => {
      // Marks the key claimed: a bubble-phase window listener (the child
      // drill-down's Esc-to-parent) yields to any handler that
      // preventDefaults, so one Esc closes the menu and nothing else.
      if (e.key === "Escape") {
        e.preventDefault();
        props.onClose();
      }
    };
    window.addEventListener("blur", close);
    window.addEventListener("resize", close);
    // Scroll doesn't bubble; capture catches the lists' scrollers.
    window.addEventListener("scroll", close, true);
    window.addEventListener("keydown", key);
    return () => {
      window.removeEventListener("blur", close);
      window.removeEventListener("resize", close);
      window.removeEventListener("scroll", close, true);
      window.removeEventListener("keydown", key);
    };
  }, []);
  return (
    <>
      <div
        class="backdrop"
        onClick={props.onClose}
        onContextMenu={(e) => {
          // A right-click elsewhere closes ours and stays closed:
          // stopPropagation keeps the row's own handler (which re-opens
          // at the pointer) out of the bubble path.
          e.preventDefault();
          e.stopPropagation();
          props.onClose();
        }}
      />
      <div
        ref={ref}
        class="menu row-menu"
        role="menu"
        style={{ left: pos.x, top: pos.y }}
        onContextMenu={(e) => {
          // Right-click on the open menu itself: no native menu, no
          // re-open - it just stays.
          e.preventDefault();
          e.stopPropagation();
        }}
      >
        {props.children}
      </div>
    </>
  );
}
