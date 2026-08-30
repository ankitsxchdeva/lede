# PRODUCT.md

## Register

product

## Users

Self-hosters running lede on their home server and setting it as their
browser homepage. Technical, privacy-leaning, allergic to algorithmic feeds.
They open this page dozens of times a day, often first thing in the morning.

## Product Purpose

A daily news digest that doubles as the browser homepage: what your own
sources published since midnight, grouped into sections, deduped, with
optional local-LLM summaries. The page should disappear into the morning
routine: glance at the time, search the web, scan the headlines.

## Brand Personality

Quiet, editorial, considered. A broadsheet front page, not a dashboard.
No gamification, no engagement tricks, no visual noise.

## Anti-references

- Not a SaaS metrics dashboard (no hero metrics, no charts)
- Not an RSS reader with unread-count anxiety (no counts, no inbox)
- Not a maximalist startpage (no widget grid, no weather tile, no to-do list)

## Strategic Design Principles

1. Calm over dense: whitespace is the product; the news is the content.
2. The tool disappears: familiar affordances, system-appropriate states,
   no invented interactions.
3. Browser-local by default: settings, saved list, and read state live in
   localStorage; the server stays read-only.
4. Degrades gracefully: no LLM, dead feeds, or a down server still render
   a useful page.
