import { useEffect, useRef, useState } from "preact/hooks";
import { createPortal } from "preact/compat";
import { signal } from "@preact/signals";

// Attached-image lightbox (Claude Code's): full-viewport preview over a dark
// backdrop, opened from an attachment chip in the composer or on a user pill.
// Left-click zooms in toward the cursor, right-click zooms back out, holding
// a button drags the zoomed picture around its box; Esc, a backdrop click or
// the × dismisses. Mounted once at the app root — openLightbox from anywhere.

export const imgPreview = signal<{ uri: string; name: string } | undefined>(
  undefined,
);

export const openLightbox = (f: { uri: string; name: string }) => {
  imgPreview.value = f;
};

export function Lightbox() {
  const open = imgPreview.value;
  const [zoom, setZoom] = useState(1);
  const [pan, setPan] = useState({ x: 0, y: 0 });
  const drag = useRef<{
    x: number;
    y: number;
    px: number;
    py: number;
    moved: boolean;
    button: number;
  } | null>(null);
  // A right-button drag ends with a contextmenu event; this flag tells it
  // the gesture was a pan, not a zoom-out click.
  const skipZoom = useRef(false);
  // Cursor truth for the picture: a grabbing hand while the drag is live,
  // + lens when only scaling up is ahead, − at the ceiling.
  const [panning, setPanning] = useState(false);
  const close = () => (imgPreview.value = undefined);
  // The Esc close can't ride the image (it never keeps focus) — it watches
  // the window while the preview is up.
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.preventDefault();
        close();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open]);

  // The pan may not pull a scaled edge inside the box — the picture always
  // covers the frame (at 100% there is no slack, so no pan).
  const clampPan = (t: { x: number; y: number }, z: number, w: number, h: number) => {
    const mx = ((z - 1) * w) / 2;
    const my = ((z - 1) * h) / 2;
    return {
      x: Math.max(-mx, Math.min(mx, t.x)),
      y: Math.max(-my, Math.min(my, t.y)),
    };
  };
  // Zoom by `factor` keeping the point under (cx, cy) under it: solve
  // translate + scale for the new offset. Shared by click, wheel and
  // right-click (which zooms out from the box's center).
  const zoomAt = (
    img: HTMLImageElement,
    cx: number,
    cy: number,
    factor: number,
  ) => {
    const frame = img.parentElement!.getBoundingClientRect();
    const rx = cx - (frame.left + frame.width / 2);
    const ry = cy - (frame.top + frame.height / 2);
    const px = (rx - pan.x) / zoom;
    const py = (ry - pan.y) / zoom;
    const z2 = Math.max(1, Math.min(8, zoom * factor));
    setPan(
      clampPan(
        { x: rx - z2 * px, y: ry - z2 * py },
        z2,
        img.offsetWidth,
        img.offsetHeight,
      ),
    );
    setZoom(z2);
  };

  if (!open) return null;
  return createPortal(
    <div class="img-preview" onClick={close}>
      {/* The picture zooms instead of closing — clicks on it must not
          bubble to the backdrop's close. A press that moves < 4px is a
          click (LMB zooms in toward the point, RMB zooms out); anything
          more is a drag: the translate shifts the view, clamped so the
          box stays covered. The frame clips the zoomed image to its fit
          box, keeping the backdrop, label and × clear. */}
      <div class="img-box">
        {/* The frame hugs the picture, so the × straddles its corner
            instead of floating at the viewport's edge. */}
        <div class="img-frame">
          <img
            src={open.uri}
            alt={open.name}
            /* Native image drag-and-drop must not fight the pan: a
               hesitant press would otherwise pick the picture up as a
               drag ghost instead of moving the view. */
            draggable={false}
            onDragStart={(e) => e.preventDefault()}
            style={{
              transform: `translate(${pan.x}px, ${pan.y}px) scale(${zoom})`,
              cursor: panning
                ? "grabbing"
                : zoom >= 8
                  ? "zoom-out"
                  : "zoom-in",
            }}
            onClick={(e) => e.stopPropagation()}
            onPointerDown={(e) => {
              if (e.button !== 0 && e.button !== 2) return;
              setPanning(true);
              drag.current = {
                x: e.clientX,
                y: e.clientY,
                px: pan.x,
                py: pan.y,
                moved: false,
                button: e.button,
              };
              // Track the drag outside the box. Synthetic pointers
              // (tests) have no active id to capture — the handlers
              // don't depend on it.
              try {
                e.currentTarget.setPointerCapture(e.pointerId);
              } catch {}
            }}
            onPointerMove={(e) => {
              const d = drag.current;
              if (!d) return;
              // A pointerup missed (button released outside the view)
              // must not leave the picture glued to the cursor — a move
              // with no held button ends the drag.
              if (e.buttons === 0) {
                drag.current = null;
                setPanning(false);
                return;
              }
              const dx = e.clientX - d.x;
              const dy = e.clientY - d.y;
              if (Math.abs(dx) + Math.abs(dy) > 4) d.moved = true;
              if (!d.moved) return;
              const img = e.currentTarget;
              setPan(
                clampPan(
                  { x: d.px + dx, y: d.py + dy },
                  zoom,
                  img.offsetWidth,
                  img.offsetHeight,
                ),
              );
            }}
            onPointerUp={(e) => {
              const d = drag.current;
              drag.current = null;
              setPanning(false);
              // The release decides click vs drag per button: LMB
              // click zooms in; an RMB click zooms out via the
              // contextmenu that follows.
              skipZoom.current = !!d && d.moved && d.button === 2;
              if (!d || d.moved || d.button !== 0) return;
              zoomAt(e.currentTarget, e.clientX, e.clientY, 1.5);
            }}
            onPointerCancel={() => {
              drag.current = null;
              setPanning(false);
            }}
            onWheel={(e) => {
              // The transcript underneath must not scroll while zooming.
              e.preventDefault();
              e.stopPropagation();
              zoomAt(
                e.currentTarget,
                e.clientX,
                e.clientY,
                e.deltaY < 0 ? 1.2 : 1 / 1.2,
              );
            }}
            onContextMenu={(e) => {
              e.preventDefault();
              e.stopPropagation();
              // A right-button drag just panned the view; only a
              // right-button click zooms out.
              if (skipZoom.current) {
                skipZoom.current = false;
                return;
              }
              const img = e.currentTarget;
              const f = img.parentElement!.getBoundingClientRect();
              zoomAt(
                img,
                f.left + f.width / 2,
                f.top + f.height / 2,
                1 / 1.5,
              );
            }}
          />
        </div>
        <button
          type="button"
          class="img-preview-x"
          title="Close"
          aria-label="Close preview"
          onClick={close}
        >
          ×
        </button>
      </div>
      <span class="img-preview-name">
        {open.name}
        {zoom > 1 ? ` · ${Math.round(zoom * 100)}%` : ""}
      </span>
    </div>,
    document.body,
  );
}
