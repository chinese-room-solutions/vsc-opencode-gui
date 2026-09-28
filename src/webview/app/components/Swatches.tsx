import { TILE_COLOR_NAMES, tileFor } from "../tile";

// The choosable palette as a swatch strip — the project row and the model
// menu both recolor a letter tile through it. One place so both pickers
// offer the same colors in the same order.
export function Swatches(props: {
  value?: string;
  onPick: (color: string) => void;
}) {
  return (
    <span class="swatches" role="radiogroup" aria-label="Tile color">
      {TILE_COLOR_NAMES.map((name) => (
        <button
          key={name}
          class={`swatch${props.value === name ? " on" : ""}`}
          role="radio"
          aria-checked={props.value === name}
          title={name}
          style={{ background: tileFor(name, name).color }}
          onMouseDown={(e) => {
            e.preventDefault();
            props.onPick(name);
          }}
        />
      ))}
    </span>
  );
}
