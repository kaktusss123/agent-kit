---
name: rtl-v4-fix-clause-pollution
description: "How to diagnose and surgically fix tl_parser clause-pollution in rtl-v4 proposals using the official domain API when full retranslation isn't possible."
---

# Fix tl_parser clause-pollution in rtl-v4 proposals

When Ren'Py generates empty TL files, dialogue lines like
`me "W-what?" (multiple=2) with hpunch` become a single `#` comment line.
The TL parser regex must strip `(multiple=N)` showparams AND `with <clause>`
transition from the source comment, otherwise both leak into the model's
input and get echoed back into translations, producing broken Ren'Py
syntax on apply (e.g. `me "Ч-что?\" (multiple=2) with hpunch" (multiple=2) with hpunch`).

## Parser fix (one-time, in `src/rtl_v4/domain/tl_parser.py`)

Expand both regexes to accept optional `(...)` between closing quote and
optional `with`:

```python
_SOURCE_COMMENT_PATTERN = re.compile(
    rf'^#\s+(?:(\w+)\s+)?\"{_STR_BODY}\"(?:\s*\([^)]*\))?\s*(?:with\b.*)?\s*$'
)
_DIALOGUE_LINE_PATTERN = re.compile(
    rf'^\s*(\w+)?\s*\"{_STR_BODY}\"(?:\s*\([^)]*\))?\s*(?:with\b.*)?\s*$'
)
```

Regression tests in `tests/unit/test_tl_parser_showparam.py` with matrix
of (showparam, clause) combinations.

## Data repair for already-polluted proposals

When full retranslation isn't possible (no targeted retranslate command),
surgically mutate affected proposals using the official domain API:

1. **Identify**: scan all `*.json` in `translations/proposals/` for
   `\(multiple=\d+\)|\bwith\s+(?:dis|dissolve|Dissolve|hpunch|vpunch|fade)`
   in source_text or translated_text. Skip false positives like
   parenthetical narration `(I guess...)`.

2. **Backup**: `cp -r proposals proposals.bak-pre-clause-fix` BEFORE any
   mutation. File-level restore after — never directory-level rm if
   state contains other artifacts (diagnostics, audits).

3. **Mutate per unit** using `TranslationProposal.model_dump(mode="json")`:
   - `hashlib.sha256(new_source_text.encode()).hexdigest()` for
     `source_fingerprint` (matches `_compute_source_fingerprint` exactly)
   - `validate_translation(source, target, tokenize_protected(source))`
     for the validation block (passed/flags/errors)
   - Preserve `context_fingerprint`, `model_id`, `review` from original
   - Add `_human_override_at` / `_human_override_reason` audit fields

4. **Rebuild bundle** from on-disk files: `proposals_russian.json` must be
   regenerated from the patched files (apply reads only this bundle).

5. **Apply**: `rtl apply --retranslate` to overwrite polluted TL entries.

6. **Verify**: `grep -nE 'multiple=' tl/russian/*.rpy` should show only
   LEGITIMATE `(multiple=N)` AFTER closing quote (legitimate showparams)
   and ZERO duplicated patterns inside the quote.

## Warning signs the regex is wrong

If `grep -nE '"[^"]*\(multiple=\d+[^"]*"'` returns nothing but
`grep -nE 'multiple='` finds many hits, the second pattern is too loose
(everything matching `multiple=`). Always verify with a quoted-context
search before claiming a count.
