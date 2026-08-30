# DESIGN.md

## Visual Theme

Ink-plum on lavender paper. Flat, hairline borders, generous whitespace.
One voice: signal indigo, used for links and primary affordances only.
Light theme is the primary scene (morning coffee, bright room); dark is the
same palette inverted, plum-tinted, never pure black.

## Color Palette

Light: bg `#f5f4fa` (lavender paper), fg `#30292f` (ink plum),
link `#355691`, link-hover `#5F5AA2`, muted `#6a6884`, border `#d8d6e8`.

Dark: bg `#1e1c22`, fg `#e8e4f4`, link `#8b87c8`, link-hover `#9db8dc`,
muted `#8e8aab`, border `#413F54`.

Theme override via `data-theme="light|dark"` on `<html>`; absence means
follow `prefers-color-scheme`.

## Typography

Lato (self-hosted woff2, 400/700, latin + latin-ext). Body 15px/1.65.
Hierarchy through weight and size contrast: section names small and
lowercase, entry titles 700, timestamps and sources muted.
Tabular numerals (`font-variant-numeric: tabular-nums`) for the clock.

## Components

- Links: indigo, squiggle underline on hover (animated sine wave),
  `:focus-visible` outline in link-hover.
- Buttons are text-level affordances (lowercase, hairline underline or
  bordered chip), never filled SaaS buttons. Active state = indigo text.
- Tabs (today / week / saved): text buttons, active = bold + hairline
  underline; `aria-current`.
- Entries: hairline-separated rows, not cards. Title, summary, meta row
  (time, source, new badge, save).
- "new" badge: small bordered chip, muted until read.
- Panels/popovers (settings): flat, `--bg` surface, 1px `--border`,
  small radius, no shadow in light theme; slight lift permitted in dark.
- Skeleton rows while loading; empty states teach ("nothing saved yet; hit
  save on any article.").

## Layout

Single column flow, max-width 1360px, sections in a 3-column grid on wide
screens collapsing to 1 column under ~900px. Masthead: wordmark + tabs,
search right. Homepage band (clock/date/search) sits between masthead and
sections.

## Motion

150–250ms ease-out. Entry rows stagger in (existing `--stagger` pattern).
No layout-property animation, no bounce. Clock ticks without transition.
Respect `prefers-reduced-motion`.
