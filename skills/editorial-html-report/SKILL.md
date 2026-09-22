---
name: editorial-html-report
description: >-
  Create a polished self-contained single-file HTML report in a dark editorial style. Use when the deliverable is a shareable `.html` page — report, spec, implementation plan, postmortem, research summary — and prefer it over Markdown when hierarchy, comparisons, metrics, or lightweight interaction materially improve readability.
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
8. Publication is a separate public side effect, never implicit in report generation. Follow **Optional public publishing** below.

## Output contract

- Produce valid semantic HTML5 with `<!doctype html>`, charset, viewport metadata, and a useful `<title>`.
- Make the file self-contained by default: no build step, no React, no Tailwind runtime, no remote fonts, no CDN libraries, no external images required for core content.
- Use real supplied content. Never invent metrics, findings, quotes, evidence, links, or conclusions to make the page look fuller.
- Prefer native HTML and CSS for interaction: anchors, `<details>`, `<summary>`, sticky navigation, tables, and CSS charts.
- Add JavaScript only when the report benefits from real data exploration that native HTML cannot provide, such as filtering, sorting, searching, threshold controls, or expandable row detail. Keep it small, inline, and framework-free. Follow `references/interaction-guide.md`.
- Do not upload during HTML generation. The artifact should be ready to upload unchanged to static hosting; public publication is an optional separate side effect governed below.

## Optional public publishing

A finished report is upload-ready but not published. Publication is a separate public side effect: a prior explicit ask counts as approval; otherwise ask before any upload and make the exposure clear.

Only after approval: read `references/publishing.md` and run the bundled `scripts/publish-report.sh` (pass `--project <name>` when the project is obvious). Never publish secrets, credentials, private source excerpts, internal-only URLs, or personal data. If the script says the upload succeeded but public verification failed, report both the failure and the candidate URL; do not retry blindly. Do not delete the local report automatically after publication.

## Safety and portability

If the report contains user-controlled or machine-generated text, escape it before inserting into HTML. Never interpolate untrusted text into `<script>` or event-handler attributes. Keep prose concise and concrete, and preserve exact identifiers, paths, commands, and measured values — the visual language itself lives in `references/style-guide.md`.

When the report will be shared publicly, do not include secrets, credentials, internal-only URLs, private source excerpts, or local filesystem paths unless the user explicitly intends to publish them.
