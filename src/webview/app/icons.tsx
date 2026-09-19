// Small inline icons shared by the toolbar and Home. Stroke icons inherit
// `currentColor` so they follow text tokens.

export function GridIcon() {
  return (
    <svg
      width="16"
      height="16"
      viewBox="0 0 16 16"
      fill="currentColor"
      aria-hidden="true"
    >
      <rect x="2" y="2" width="5.4" height="5.4" rx="1.5" />
      <rect x="8.6" y="2" width="5.4" height="5.4" rx="1.5" />
      <rect x="2" y="8.6" width="5.4" height="5.4" rx="1.5" />
      <rect x="8.6" y="8.6" width="5.4" height="5.4" rx="1.5" />
    </svg>
  );
}

export function NewSessionIcon() {
  return (
    <svg
      width="16"
      height="16"
      viewBox="0 0 16 16"
      fill="none"
      stroke="currentColor"
      stroke-width="1.5"
      stroke-linecap="round"
      aria-hidden="true"
    >
      <rect x="2.2" y="2.2" width="11.6" height="11.6" rx="2.6" />
      <path d="M8 5.4v5.2M5.4 8h5.2" />
    </svg>
  );
}

export function PlusIcon() {
  return (
    <svg
      width="16"
      height="16"
      viewBox="0 0 16 16"
      fill="none"
      stroke="currentColor"
      stroke-width="1.7"
      stroke-linecap="round"
      aria-hidden="true"
    >
      <path d="M8 3.2v9.6M3.2 8h9.6" />
    </svg>
  );
}

export function SearchIcon() {
  return (
    <svg
      width="16"
      height="16"
      viewBox="0 0 16 16"
      fill="none"
      stroke="currentColor"
      stroke-width="1.5"
      stroke-linecap="round"
      aria-hidden="true"
    >
      <circle cx="7" cy="7" r="4.4" />
      <path d="M10.4 10.4 14 14" />
    </svg>
  );
}

export function CloseIcon() {
  // 12px glyph, 2px stroke (1.5px ink at this size): a thin stroke at a
  // fractional zoom antialiases unevenly and the × reads as off-center.
  return (
    <svg
      width="12"
      height="12"
      viewBox="0 0 16 16"
      fill="none"
      stroke="currentColor"
      stroke-width="2"
      stroke-linecap="round"
      aria-hidden="true"
    >
      <path d="M4 4l8 8M12 4l-8 8" />
    </svg>
  );
}

export function CopyIcon() {
  return (
    <svg
      width="13"
      height="13"
      viewBox="0 0 16 16"
      fill="none"
      stroke="currentColor"
      stroke-width="1.4"
      stroke-linejoin="round"
      aria-hidden="true"
    >
      <rect x="5.5" y="5.5" width="8" height="8" rx="1.6" />
      <path d="M10.5 3.5h-6a2 2 0 0 0-2 2v6" />
    </svg>
  );
}

export function CheckIcon() {
  return (
    <svg
      width="13"
      height="13"
      viewBox="0 0 16 16"
      fill="none"
      stroke="currentColor"
      stroke-width="1.8"
      stroke-linecap="round"
      stroke-linejoin="round"
      aria-hidden="true"
    >
      <path d="M3 8.6 6.4 12 13 4.6" />
    </svg>
  );
}

export function ChevronIcon() {
  return (
    <svg
      width="10"
      height="10"
      viewBox="0 0 16 16"
      fill="none"
      stroke="currentColor"
      stroke-width="1.6"
      stroke-linecap="round"
      stroke-linejoin="round"
      aria-hidden="true"
    >
      <path d="M4 6l4 4 4-4" />
    </svg>
  );
}

export function ArrowUpIcon() {
  return (
    <svg
      width="15"
      height="15"
      viewBox="0 0 16 16"
      fill="none"
      stroke="currentColor"
      stroke-width="1.8"
      stroke-linecap="round"
      stroke-linejoin="round"
      aria-hidden="true"
    >
      <path d="M8 13V3.4M3.8 7.4 8 3.2l4.2 4.2" />
    </svg>
  );
}

export function StopIcon() {
  return (
    // Integer box (10px, 1:1 viewBox) with a symmetric inset: the glyph
    // stays small and can't rasterize off-center at fractional scalings
    // (125–175%) — the old 16-unit viewBox at 11px could.
    <svg width="10" height="10" viewBox="0 0 10 10" aria-hidden="true">
      <rect x="1.5" y="1.5" width="7" height="7" rx="1.2" fill="currentColor" />
    </svg>
  );
}

export function SlidersIcon() {
  return (
    <svg
      width="14"
      height="14"
      viewBox="0 0 16 16"
      fill="none"
      stroke="currentColor"
      stroke-width="1.5"
      stroke-linecap="round"
      aria-hidden="true"
    >
      <path d="M2 5h4.2M10.8 5H14M2 11h2.2M9.8 11H14" />
      <circle cx="8.4" cy="5" r="1.9" />
      <circle cx="6.6" cy="11" r="1.9" />
    </svg>
  );
}

export function PencilIcon() {
  return (
    <svg
      width="13"
      height="13"
      viewBox="0 0 16 16"
      fill="none"
      stroke="currentColor"
      stroke-width="1.4"
      stroke-linecap="round"
      stroke-linejoin="round"
      aria-hidden="true"
    >
      <path d="M3.2 12.8l.6-2.6 6.9-6.9 2 2-6.9 6.9zM9.4 4.6l2 2M11.5 2.5a1.4 1.4 0 0 1 2 2l-.7.7-2-2z" />
    </svg>
  );
}

export function TrashIcon() {
  return (
    <svg
      width="13"
      height="13"
      viewBox="0 0 16 16"
      fill="none"
      stroke="currentColor"
      stroke-width="1.4"
      stroke-linecap="round"
      stroke-linejoin="round"
      aria-hidden="true"
    >
      <path d="M2.5 4.4h11M6.4 2.4h3.2M4.2 4.4l.6 8a1.6 1.6 0 0 0 1.6 1.5h3.2a1.6 1.6 0 0 0 1.6-1.5l.6-8" />
      <path d="M6.6 7.2v4M9.4 7.2v4" />
    </svg>
  );
}

// OpenCode's own user-message action glyphs, lifted from its web bundle's
// icon registry (names "copy", "reset", "check") so the row reads native.
export function OcCopyIcon() {
  return (
    <svg
      width="13"
      height="13"
      viewBox="0 0 16 16"
      fill="none"
      stroke="currentColor"
      aria-hidden="true"
    >
      <path d="M4.14908 11.0081H1.76282V1.51758H9.1038V2.55588M14.2225 4.99681H6.75397V14.4873H14.2225V4.99681Z" />
    </svg>
  );
}

export function OcResetIcon() {
  return (
    <svg
      width="13"
      height="13"
      viewBox="0 0 20 20"
      fill="none"
      stroke="currentColor"
      aria-hidden="true"
    >
      <path
        d="M5.83333 4.16406L2.5 7.4974L5.83333 10.8307M3.33333 7.4974H17.9167V15.4141H10"
        stroke-linecap="square"
      />
    </svg>
  );
}

export function OcCheckIcon() {
  return (
    <svg
      width="13"
      height="13"
      viewBox="0 0 16 16"
      fill="none"
      stroke="currentColor"
      aria-hidden="true"
    >
      <path d="M3.53613 8.17857L6.39328 11.75L12.4647 4.25" />
    </svg>
  );
}

// The "opencode" wordmark, lifted from its ui package's WordmarkV2 (the
// glyph over the new-session screen): letters sink into the background —
// a mask fades them out toward the baseline instead of a hard bottom edge.
export function WordmarkIcon() {
  return (
    <svg
      class="wordmark"
      xmlns="http://www.w3.org/2000/svg"
      viewBox="0 0 720 129"
      fill="none"
      aria-hidden="true"
    >
      <g opacity="0.6">
        <g mask="url(#oc-wordmark-mask)">
          <g opacity="0.16">
            <path
              opacity="0.7"
              d="M55.3846 36.4286H18.4615V91.7143H55.3846V36.4286ZM73.8462 110.143H0V18H73.8462V110.143Z"
              fill="currentColor"
            />
            <path
              opacity="0.7"
              d="M110.462 91.7143H147.385V36.4286H110.462V91.7143ZM165.846 110.143H110.462V128.571H92V18H165.846V110.143Z"
              fill="currentColor"
            />
            <path
              opacity="0.7"
              d="M258.846 73.2857H203.462V91.7143H258.846V110.143H185V18H258.846V73.2857ZM203.462 54.8571H240.385V36.4286H203.462V54.8571Z"
              fill="currentColor"
            />
            <path
              opacity="0.7"
              d="M332.385 36.4286H295.462V110.143H277V18H332.385V36.4286ZM350.846 110.143H332.385V36.4286H350.846V110.143Z"
              fill="currentColor"
            />
            <path
              opacity="0.7"
              d="M442.846 36.4286H387.462V91.7143H442.846V110.143H369V18H442.846V36.4286Z"
              fill="currentColor"
            />
            <path
              opacity="0.7"
              d="M517.385 36.4286H480.462V91.7143H517.385V36.4286ZM535.846 110.143H462V18H535.846V110.143Z"
              fill="currentColor"
            />
            <path
              opacity="0.7"
              d="M609.385 36.8571H572.462V92.1429H609.385V36.8571ZM627.846 110.571H554V18.4286H609.385V0H627.846V110.571Z"
              fill="currentColor"
            />
            <path
              opacity="0.7"
              d="M664.462 36.4286V54.8571H701.385V36.4286H664.462ZM719.846 73.2857H664.462V91.7143H719.846V110.143H646V18H719.846V73.2857Z"
              fill="currentColor"
            />
          </g>
        </g>
      </g>
      <defs>
        <mask
          id="oc-wordmark-mask"
          style="mask-type:alpha"
          maskUnits="userSpaceOnUse"
          x="0"
          y="0"
          width="720"
          height="129"
        >
          <rect width="720" height="129" fill="url(#oc-wordmark-fade)" />
        </mask>
        <linearGradient
          id="oc-wordmark-fade"
          x1="360"
          y1="68"
          x2="360"
          y2="129"
          gradientUnits="userSpaceOnUse"
        >
          <stop stop-color="white" stop-opacity="0.7" />
          <stop offset="1" stop-color="white" stop-opacity="0" />
        </linearGradient>
      </defs>
    </svg>
  );
}

// opencode's pixel spinner, lifted from its ui package's Spinner (the busy
// mark on session tabs and sub-agent chips): a 4x4 grid of cells, each
// pulsing opacity on its own clock — outer ring dimmer, corners dark. The
// randomization is shared by every instance, like upstream's module-level
// array (one pattern per page load).
const SPIN_OUTER = new Set([1, 2, 4, 7, 8, 11, 13, 14]);
const SPIN_CORNER = new Set([0, 3, 12, 15]);
const SPIN_CELLS = Array.from({ length: 16 }, (_, i) => ({
  x: (i % 4) * 4,
  y: Math.floor(i / 4) * 4,
  delay: Math.random() * 1.5,
  duration: 1 + Math.random(),
  outer: SPIN_OUTER.has(i),
  corner: SPIN_CORNER.has(i),
}));

export function PixelSpinner(props: { tone?: "attention" | "ready" }) {
  return (
    <svg
      class={["pixel-spin", props.tone].filter(Boolean).join(" ")}
      viewBox="0 0 15 15"
      fill="currentColor"
      aria-hidden="true"
    >
      {SPIN_CELLS.map((c) => (
        <rect
          key={`${c.x}:${c.y}`}
          x={c.x}
          y={c.y}
          width="3"
          height="3"
          rx="1"
          style={
            c.corner
              ? { opacity: "0" }
              : {
                  animation: `${c.outer ? "pulse-opacity-dim" : "pulse-opacity"} ${c.duration}s ease-in-out infinite both`,
                  "animation-delay": `${c.delay}s`,
                }
          }
        />
      ))}
    </svg>
  );
}

// The same grid at rest — the settled sub-agent chip's mark, so a chip reads
// as the same pixel square whether it is working or done. Corners stay dark;
// a failed sub-agent tints the square through `currentColor` (styles.css).
export function PixelMark(props: {
  failed?: boolean;
  tone?: "attention" | "ready";
}) {
  return (
    <svg
      class={["pixel-mark", props.tone, props.failed ? "failed" : undefined]
        .filter(Boolean)
        .join(" ")}
      viewBox="0 0 15 15"
      fill="currentColor"
      aria-hidden="true"
    >
      {SPIN_CELLS.filter((c) => !c.corner).map((c) => (
        <rect
          key={`${c.x}:${c.y}`}
          x={c.x}
          y={c.y}
          width="3"
          height="3"
          rx="1"
        />
      ))}
    </svg>
  );
}
