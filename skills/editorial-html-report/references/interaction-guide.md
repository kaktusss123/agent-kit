# Interaction patterns for editorial HTML reports

Use interaction only when it lets the reader answer a real follow-up question without leaving the report. Keep the page useful before JavaScript runs.

## Good reasons to add controls

Add controls when the report contains a dataset or evidence set large enough that static presentation hides useful comparisons. Typical cases:

- filter a classifier, benchmark, experiment, issue, or evidence table;
- change a meaningful threshold or cutoff and recompute the visible result;
- search a long set of rows by name, path, finding, or label;
- sort a dense table by one of a few important columns;
- expand one row to reveal the exact rule, evidence, examples, logs, or rationale;
- switch between a small number of explicitly defined views of the same data.

Do not add controls just to make a static report feel like an application.

## Preferred control strip

Keep controls directly on the page. Do not wrap the whole control area in a card.

A useful desktop arrangement is:

```text
Primary group        Threshold 0.80        Find a classifier             Reset
[ All tasks      v ] [-----o----------]    [ scope, failure, workflow ]  [ Reset ]
```

Rules:

- Use native `<select>`, `<input type="range">`, `<input type="search">`, and `<button>`.
- Place a visible text label above each control.
- Use the lavender accent on the active range track/value and focus states.
- Keep controls rectangular with small radii. Avoid pill controls.
- Let the row wrap or stack below about 800px.
- Put a compact live summary below the controls, for example `1,118 threads · all tasks · threshold 0.80`.

## Interactive tables

Use the same editorial table language as static tables:

- hairline row separators;
- no outer card or heavy table border;
- muted headers;
- numeric columns right-aligned;
- small horizontal bars for a share or score when visual comparison helps;
- a disclosure triangle or chevron only for rows that actually expand.

Expanded detail may show the exact rule, examples, source snippets, changed files, or validation evidence. Keep the detail inline under the selected row instead of opening a modal unless the content is too large for the page.

## JavaScript rules

Use small vanilla JavaScript and embedded data. No framework or network dependency is needed for this class of report.

- Keep source data in a JSON-compatible structure inside the document.
- Derive the visible rows and summary from state instead of mutating source data.
- Re-render only the affected region.
- Update a nearby `aria-live="polite"` summary after filtering.
- Make `Reset` restore the exact initial state.
- Preserve native keyboard behavior and visible focus rings.
- Clamp numeric inputs and thresholds.
- Never use `innerHTML` with untrusted or model-generated strings. Create text nodes or assign `textContent`.
- Do not send analytics, fetch remote data, or write cookies/local storage unless the user explicitly asks for those capabilities.

The report should still expose its core findings if JavaScript fails. Interaction refines or explores the evidence; it must not be the only route to the main conclusion.

## When not to use interaction

Stay static when the reader only needs to consume a conclusion, a short plan, a small comparison, or a handful of findings. A four-row table does not need search. A fixed acceptance threshold does not need a slider. A short report does not need collapsible primary sections.

The test is simple: if the control does not answer a plausible reader question, remove it.

## Reusable example

Use `assets/explorer-pattern.html` as the reference implementation for a filter row, range threshold, search, reset, live summary, proportional bars, and expandable table rows. Adapt the data and labels to the report. Do not copy sample values into a real report.
