---
name: editorial-html-report
description: >-
  Create polished self-contained single-file HTML5 reports, specs, research summaries, implementation plans, postmortems, and analysis pages in a dark editorial style with a near-black background, strong white typography, thin rules, restrained lavender accent, metric strips, CSS bar charts, and concise callouts. Use when the deliverable should be a shareable `.html` file that opens directly in a browser or can be published to static hosting such as S3. Prefer this over Markdown when hierarchy, comparisons, metrics, diagrams, or lightweight interaction materially improve readability.
---

# Editorial HTML report

Create one standalone HTML5 document that is easy to scan, easy to share, and visually closer to a well-edited technical article than a dashboard.

## Workflow

1. Determine the report's actual job: explain findings, compare options, present a plan, document verification, or summarize an investigation.
2. Read `references/style-guide.md` before choosing layout or styles.
3. If filtering, searching, threshold exploration, sorting, or expandable evidence would materially help the reader, also read `references/interaction-guide.md` and use `assets/explorer-pattern.html` as a behavioral reference.
4. Use `assets/report-template.html` as the default scaffold when file access permits. Replace its sample content; do not preserve sections that do not serve the report.
5. Structure the information before decorating it. Put the highest-value facts first and move evidence or long detail later.
6. Produce one `.html` file with essential CSS inline. Keep JavaScript inline and optional.
7. Verify the finished file in a browser when browser tooling is available. Check one wide viewport and one narrow viewport, exercise every interactive control, and fix overflow, clipping, unreadable contrast, broken anchors, dead controls, and incorrect reset behavior.
8. After the report is complete and verified, if a public shareable URL would materially help, follow **Optional public publishing** below. Publication is a separate side effect and is never implicit in report generation.

## Output contract

- Produce valid semantic HTML5 with `<!doctype html>`, charset, viewport metadata, and a useful `<title>`.
- Make the file self-contained by default: no build step, no React, no Tailwind runtime, no remote fonts, no CDN libraries, no external images required for core content.
- Use real supplied content. Never invent metrics, findings, quotes, evidence, links, or conclusions to make the page look fuller.
- Prefer native HTML and CSS for interaction: anchors, `<details>`, `<summary>`, sticky navigation, tables, and CSS charts.
- Add JavaScript only when the report benefits from real data exploration that native HTML cannot provide, such as filtering, sorting, searching, threshold controls, or expandable row detail. Keep it small, inline, and framework-free. Follow `references/interaction-guide.md`.
- Do not upload during HTML generation. The artifact should be ready to upload unchanged to static hosting; public publication is an optional separate side effect governed below.

## Optional public publishing

A finished report can be published with the bundled `scripts/publish-report.sh`. Treat publication as a separate public side effect, not as another rendering step.

1. Finish and verify the report locally first.
2. Decide whether a shareable URL is useful. Do not suggest public publication when the report contains secrets, credentials, private source excerpts, internal-only URLs, personal data, or other content that should not become public.
3. If the user already explicitly asked to publish this report, that request is approval. Otherwise ask before any upload and make the exposure clear, for example: "The report is ready. Publish it to the public report bucket? Anyone with the URL can access it."
4. Only after approval, read `references/publishing.md` and run the bundled `scripts/publish-report.sh`. Pass `--project <name>` when the project is obvious.
5. Return the verified public URL. If the script says the upload succeeded but public verification failed, report both the failure and the URL because the object may already exist publicly. Do not retry blindly.
6. Do not delete the local report automatically after publication.

## Information hierarchy

Use only the patterns the content earns:

- Compact top navigation with underlined text links for 3-7 major sections.
- Metric strip for 2-5 important numbers. Metrics sit directly on the page, not inside cards.
- Thin horizontal rules to separate major regions.
- Two-column editorial section for a primary chart/list plus interpretation or implications.
- Horizontal CSS bars for small categorical comparisons where exact values matter.
- Accent-line callouts for findings, caveats, decisions, risks, or next steps.
- Plain tables with row rules for dense evidence.
- A compact control strip plus live-updating table when the reader needs to explore a non-trivial dataset.
- `<details>` for raw logs, methodology, long evidence, or secondary examples.
- Inline SVG only when a relationship is genuinely spatial and cannot be expressed cleanly with CSS or text.

For plans and specs, adapt the same visual language instead of forcing data widgets. A plan may use milestones, decision callouts, dependency rows, and expandable implementation detail without any fake metrics.

## Writing style

Keep prose concise and concrete. Prefer short headings and paragraphs. Let typography and spacing carry hierarchy rather than boxes, badges, and decoration.

Use labels that state what the reader is looking at. Use callouts to explain why a result matters, not to restate the adjacent number.

For technical reports, preserve exact identifiers, paths, commands, test names, issue numbers, and measured values.

## Visual constraints

Follow `references/style-guide.md`. In particular:

- Use a near-black page, off-white text, muted gray secondary text, and one restrained lavender accent.
- Prefer open space and thin rules over elevated surfaces.
- Avoid card grids, glassmorphism, gradients, large radii, decorative shadows, pill-heavy interfaces, and generic SaaS-dashboard styling.
- Keep the visual density deliberate: large numbers and headings may be bold; everything else should stay quiet.
- Use the accent for data emphasis, active navigation, and callout rules, not as a background wash everywhere.

## Safety and portability

If the report contains user-controlled or machine-generated text, escape it before inserting into HTML. Never interpolate untrusted text into `<script>` or event-handler attributes.

When the report will be shared publicly, do not include secrets, credentials, internal-only URLs, private source excerpts, or local filesystem paths unless the user explicitly intends to publish them.
