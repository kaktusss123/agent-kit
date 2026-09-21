# Dark editorial report style guide

## Visual identity

Aim for a dark editorial technical report, not an application dashboard.

The page should feel like a carefully typeset analysis: black field, bright type, muted secondary text, hairline dividers, a restrained lavender accent, direct data graphics, and very little container chrome.

## Core tokens

Use these defaults unless the user's project already has a stronger visual language:

```css
:root {
  --bg: #050505;
  --surface: #0d0d0f;
  --text: #f3f2ef;
  --muted: #a5a2aa;
  --faint: #6d6a72;
  --rule: #252527;
  --track: #1b1b1e;
  --accent: #9b8cff;
  --accent-soft: #7668dc;
  --danger: #ff6f6f;
  --warning: #e0b86a;
  --max: 1440px;
}
```

Do not add more colors without semantic need.

## Page geometry

- Main width: `min(var(--max), calc(100vw - 64px))` on desktop.
- Center the page.
- Desktop top/bottom padding: 48-64px.
- Section spacing: 42-64px.
- Use `1px solid var(--rule)` between major regions.
- Avoid outer cards around the whole report. The browser page itself is the canvas.

At widths below roughly 900px, stack editorial columns. Below roughly 640px, reduce page gutters to 18-22px and stack metric strips to one or two columns.

## Typography

Default to a local system sans stack for portability:

```css
font-family: ui-sans-serif, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
```

Recommended scale:

- Main title: 36-48px, 700-760 weight, tight line-height.
- Section heading: 22-28px, 700 weight.
- Metric value: 42-56px, 700-760 weight.
- Body: 16-18px, line-height 1.5-1.65.
- Secondary labels: 14-16px, muted.
- Tiny metadata only when necessary: 12-13px.

Do not uppercase ordinary section headings. Avoid excessive letter spacing except for genuinely tiny metadata.

## Navigation

Use a simple horizontal row of text links near the top.

- White or lightly muted text.
- Underline or bottom border as the affordance.
- No pills, tabs with filled backgrounds, or icon buttons unless the report genuinely behaves like an application.
- Allow wrapping on smaller screens.

## Metric strip

Metrics are typography, not cards.

```text
1,118                 32,311                14                    $0.37
eligible threads      messages classified   judgments / excerpt   estimated cost
```

Use a grid with 2-5 columns, large values, smaller muted labels, and generous horizontal breathing room. Put one horizontal rule below the strip.

## Two-column editorial sections

A common useful composition is approximately `60 / 40`:

- Left: chart, ranked list, evidence table, examples, or implementation detail.
- Right: interpretation, implications, risks, or decisions.

Do not draw a box around either column. Separation comes from whitespace, headings, and accent rules.

## Horizontal bar charts

Prefer CSS bars to charting libraries for small categorical comparisons.

Each row contains:

1. Label.
2. Dark neutral track.
3. Lavender fill proportional to value.
4. Exact numeric value.
5. Optional muted percentage.

Keep tracks thin, roughly 10-14px. Avoid rounded capsule bars; 0-2px radius is enough. Exact numbers should remain readable without estimating from bar length.

## Finding and decision callouts

Use a 2-3px lavender left rule and padding on the left. Do not use a filled card.

```text
│ Complexity keeps coming up
│ 145 threads flag objections to excess complexity...
```

Heading is bright and bold. Supporting prose is muted. Stack callouts with 20-28px separation.

Use `--warning` or `--danger` only when the semantics justify them.

## Tables

- Full width when useful.
- No heavy outer border.
- Hairline row separators.
- Muted column headers.
- Numeric columns right-aligned.
- Monospace only for code-like values, identifiers, or paths.
- Add horizontal scrolling for genuinely wide tables instead of shrinking text into illegibility.

## Evidence and code

For `<pre>` blocks and raw logs, a subtle `--surface` background is acceptable because the content needs containment. Keep borders thin and radii small, around 4-6px.

Use `<details>` for secondary evidence. Make the summary look like a normal text affordance, not a giant button.

## Motion and interaction

Default to static. The document should remain useful with JavaScript disabled.

Good interaction:

- Anchor navigation.
- Native disclosure sections.
- Copy button for code when specifically useful.
- Simple filtering or sorting for large evidence sets.
- A threshold slider when the threshold is part of the analysis itself.

Bad interaction:

- Decorative entrance animations.
- Hover effects on non-interactive text.
- Carousels for report content.
- Hidden primary information that requires clicking to discover.

Honor `prefers-reduced-motion` if any motion is introduced.

## Anti-patterns

Avoid all of these unless the user explicitly asks for them:

- Card soup.
- Purple gradient hero areas.
- Glassmorphism and blur panels.
- Huge rounded rectangles.
- Soft drop shadows everywhere.
- Pill-shaped labels as the default visual language.
- Decorative icons next to every heading.
- KPI dashboards with colored tiles.
- Dense control bars for static documents.
- Chart libraries for four horizontal bars.
- Generic "AI" visual motifs.

The test is simple: if removing a box, badge, shadow, or decoration makes the information clearer, remove it.

## Interactive explorer sections

When the report contains enough structured evidence to justify exploration, keep the interaction in the same visual language instead of switching to dashboard chrome.

- Put filter controls directly above the dataset, without a surrounding card.
- Use a compact row of labeled native controls: select, range, search, then a plain rectangular reset button.
- Show the active threshold or other key value inline in lavender next to its label.
- Put a one-line live summary immediately below the controls.
- Keep the results as a ruled table. Use exact numbers plus a thin lavender bar when relative magnitude matters.
- Use a small disclosure triangle for rows with secondary evidence. Expanded detail stays under the row.
- Preserve generous spacing above the table and do not turn every filter or row into a pill or tile.

Read `references/interaction-guide.md` for behavior, accessibility, and JavaScript rules. Use `assets/explorer-pattern.html` as a working reference.
