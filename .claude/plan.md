# Music.lua UI/UX Overhaul Plan

## Visual Polish

1. **Color scheme upgrade** — use accent colors (cyan for active elements, orange for highlights, purple for queue items) instead of just white/gray/black
2. **Now Playing screen** — add a visual progress indicator, show song duration/position if available, show queue count badge
3. **Tab bar** — underline active tab, add icons using Unicode-safe chars (♪ ⟐ ✎)
4. **Search bar** — rounded feel with better contrast, placeholder text styling
5. **Button styling** — consistent padding, hover-like highlight on click, better disabled state
6. **Volume slider** — show speaker icon, gradient fill effect using different gray shades
7. **Footer** — persistent status bar with keybind hints instead of just tips
8. **Loading state** — animated dots ("Loading." → "Loading.." → "Loading...")

## New Features

9. **Keyboard navigation** — Left/Right arrows to switch tabs, Up/Down to scroll lists, Enter to select, Q to go back, +/- for volume
10. **Scrollable search results** — show scroll indicator when more results than fit, track scroll offset
11. **Scrollable queue** — scroll through queue on Now Playing tab with up/down
12. **Shuffle button** — shuffle the current queue (new button on Now Playing)
13. **Clear queue button** — one-click clear all queued songs
14. **Remove from queue** — click a queue item to get remove option
15. **Song duration display** — show length next to song name in results/queue if available from API

## Files Changed

- `music.lua` — all changes in this single file

## Approach

- Keep the same 3-loop architecture (uiLoop, audioLoop, httpLoop)
- Add state vars for scroll offsets, animation frame
- Refactor draw functions for cleaner layout math
- Add keyboard event handling alongside mouse events
- Add a timer-based animation loop for loading dots
