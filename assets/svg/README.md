# Disruptopia P2P — SVG Asset Library

Hand-coded SVG assets for the Disruptopia P2P board game UI. All files are
standalone (no external CSS or fonts beyond system sans/serif) and follow the
project color palette.

## Color Palette

| Token | Hex |
|-------|-----|
| Primary indigo | `#4f46e5` (gradient partner `#7c3aed`) |
| Background cream | `#f0ece3` |
| Card cream | `#faf7f2` |
| Border tan | `#d4c9b8` |
| Text dark | `#1e1b18` |
| Muted grey | `#78716c` |
| Money green | `#16a34a` |
| Subsidy gold | `#d97706` / stroke `#b45309` |
| Reputation indigo | `#4f46e5` |
| Power amber | `#d97706` |
| Warning red | `#dc2626` |

**Player colors:** `#ef4444` (red), `#3b82f6` (blue), `#10b981` (green),
`#eab308` (yellow), `#a855f7` (purple).

## File Index

| File | Purpose |
|------|---------|
| `worker-token.svg` | Generic engineer/worker meeple. Fill = `currentColor`. |
| `subsidy-token.svg` | Gold-coin subsidy token with `$` glyph. |
| `presence-flag.svg` | Regional presence flag (pole + triangular flag, `currentColor`). |
| `p1-crown.svg` | First-player marker. Gold crown with three jewels. |
| `card-back-research.svg` | Research deck back (teal, neural-network motif). |
| `card-back-influence.svg` | Influence deck back (amber, megaphone). |
| `card-back-sabotage.svg` | Sabotage deck back (crimson, domino mask). |
| `vp-track.svg` | Horizontal 0–30 victory-points strip with milestone callouts. |
| `train-model-icon.svg` | Action: train model — neural network. |
| `buy-chips-icon.svg` | Action: buy chips — microchip with pins. |
| `recruit-icon.svg` | Action: recruit — person + plus badge. |
| `marketing-icon.svg` | Action: marketing — megaphone. |
| `scale-presence-icon.svg` | Action: scale presence — globe + pin. |
| `raise-funds-icon.svg` | Action: raise funds — stacked coins with `$`. |
| `play-card-icon.svg` | Action: play card — fanned card + star. |
| `increase-net-worth-icon.svg` | Action: increase net worth — bar chart + arrow. |

## Usage

### Via `<img>` (simplest, no recoloring)

```html
<img src="assets/svg/subsidy-token.svg" width="32" height="32" alt="Subsidy">
```

### Via CSS `currentColor` (worker tokens, presence flag, action icons)

The fill on player-tinted assets uses `currentColor`. Inline the SVG or load it
with `<object>` / a CSS mask so the parent's `color` property paints it.

```html
<style>
  .player-1 { color: #ef4444; }   /* red */
  .player-2 { color: #3b82f6; }   /* blue */
  .player-3 { color: #10b981; }   /* green */
  .player-4 { color: #eab308; }   /* yellow */
  .player-5 { color: #a855f7; }   /* purple */
</style>

<!-- Inline (recommended for currentColor) -->
<span class="player-2">
  <!-- paste contents of worker-token-bicycle.svg here -->
</span>
```

### Inline SVG example

```html
<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 48 48" width="48" height="48"
     style="color: #10b981;">
  <use href="assets/svg/worker-token.svg#root"/>
</svg>
```

(Note: `<use>` cross-file referencing requires the source SVG to expose an id;
inlining or `<img>` is more portable.)

### Card backs

Render at any aspect — the viewBox is 5:7 (200×280):

```html
<img src="assets/svg/card-back-research.svg" style="width: 120px; aspect-ratio: 5/7;">
```

### VP track

Stretch across the score area; SVG uses viewBox `0 0 600 60`.

```html
<img src="assets/svg/vp-track.svg" style="width: 100%; height: auto;">
```

## Preview

Open `preview.html` in a browser to review every asset on the cream
background, including the worker tokens tinted in each player color.
