# DESIGN.md

**Lane: canonical.** All design decisions follow
`~/Documents/design/DESIGN.md` (The Quiet Workshop). Do not invent colors,
fonts, spacing, or motion outside it; where any skill or model suggestion
conflicts, the spec wins. Tokens in `reader.css` mirror `tokens.css`.

lede is the source of the spec's structure-and-density layer, so the layout
below *is* the canonical structure:

- **Masthead:** wordmark (display tier, the page's one display use) and view
  tabs on the left; clock, dateline, dual-duty search, and settings on the
  right, compact and baseline-aligned. The clock is menubar-sized, never a
  hero.
- **Board:** hairline-ruled columns on the flat page background,
  `repeat(auto-fill, minmax(300px, 1fr))`, ~3em gutters, collapsing to one
  column under ~900px. Entry rows follow the canonical entry-row recipe
  (title → summary → meta: relative time, domain one rung down, chip badge,
  quiet save action pushed right).
- **One flourish:** the squiggle link underline.
- **Licensed shadow:** the settings popover carries the one permitted
  dark-theme shadow.
- **Kicker:** "today's themes" is the page's one uppercase element.
- **Voice:** lowercase throughout; errors render in muted ink and name the
  retry ("the server didn't answer; try again in a minute.").
