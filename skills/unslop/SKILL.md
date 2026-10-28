---
name: unslop
description: "Enhanced editorial pass that removes AI writing patterns and adds human voice. Use when: the user asks to edit, de-AI, or improve a specific text deliverable (article, report, README, docs, long prose, UI strings, product copy); the user calls the text слоп, says it reads like AI, or says the author переборщил. Not for: day-to-day style compliance; the compact global contract lives in AGENTS.md."
---

# Unslop

Edit a specific text to remove AI patterns and add human voice. This skill is an explicit editorial pass, loaded on demand; day-to-day style rules stay in the global agent instructions. The same pass applies to UI strings and product copy, where a tell costs trust on every screen.

## Process

1. Scan for the always-apply rules below and the full catalogue in `references/patterns.md`.
2. Rewrite. Preserve meaning, match intended tone.
3. Add soul (see next section).
4. Self-audit: "What makes this obviously AI generated?" Fix remaining tells.

## Adding soul

Removing patterns is half the job. Sterile, voiceless writing is just as obvious.

- **Have opinions.** React to facts instead of neutrally listing pros and cons.
- **Vary rhythm.** Short sentences. Then longer ones that take their time. Mix it up.
- **Acknowledge complexity.** "Impressive but also kind of unsettling" beats "impressive."
- **Use "I" when it fits.** First person isn't unprofessional.
- **Let some mess in.** Perfect structure looks machine-made.
- **Be specific.** Not "this is concerning" but "there's something unsettling about agents churning away at 3am."

## Always apply

These rules carry most of the value and cost nothing to apply on every pass:

- No em dashes. Use periods or commas; do not swap in parentheses or en dashes.
- Straight quotes, not curly quotes.
- Sentence-case headings; no decorative emoji.
- Cut filler, hedging, chatbot phrases, sycophancy, and generic conclusions.
- Active voice unless the actor is unknown or irrelevant.
- Prefer the plain word over the fancy synonym.
- Shorten or split a sentence the reader has to backtrack through.
- Say what the mechanism, number, or instruction is, not what it feels like.
- Rewrite inline-header lists whose bold label only restates the line.

The full pattern catalogue, with examples for each tell, is in `references/patterns.md`.
