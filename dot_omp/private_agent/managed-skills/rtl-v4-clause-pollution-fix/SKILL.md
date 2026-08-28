---
name: rtl-v4-clause-pollution-fix
description: "Repair parser-induced clause pollution in RTL v4 translation proposals using the official domain API (TranslationProposal.model_dump + sha256 source_fingerprint + validate_translation). Use when a Ren'Py source line like me \"text\" (multiple=N) with clause has its (multiple=N) or with clause portion leaking into proposal source_text and translated_text."
---

# RTL v4 Clause Pollution Fix

Surgical fix for parser-induced pollution in translation proposals. Used when
the Ren'Py-generated empty TL contains a dialogue line like:

```
# me "W-what?" (multiple=2) with hpunch
me "W-what?" (multiple=2) with hpunch
```

The source-comment regex in `tl_parser.py:107` strips only the optional
`with ...` clause and leaks `(multiple=N)` showparams into `source_text`.
The translator then echoes this back into `translated_text`, producing
broken Ren'Py syntax in the TL output.

## When to use

Symptoms:
- `grep -nE 'multiple=' /path/to/tl/russian/*.rpy` shows lines like
  `me "Ч-что?\" (multiple=2) with hpunch" (multiple=2) with hpunch`
- Proposals have `source_text` containing `(multiple=N)` or `with <word>`
- This is a fresh run after a parser fix landed (commit before the fix)

Do NOT use for:
- Translation quality issues (use review/repair workflow instead)
- Validation failures other than clause pollution
- Proposals where the pollution came from the model itself (not the parser)

## Procedure

1. **Confirm the bug**: scan TL files with `grep -nE 'multiple='` to see broken
   Ren'Py syntax. Note the affected unit_ids from proposal source_text:
   ```python
   import re
   TAIL = re.compile(r'\([^)]*multiple=[^)]*\)|\([^)]*choice[^)]*\)|'
                    r'\bwith\s+(?:dis|dissolve|Dissolve|hpunch|vpunch|fade)(?:\s*\([^)]*\))?|'
                    r'\bс\s+(?:dis|dissolve|hpunch|vpunch|fade|эффектом|растворени[ияе])')
   # walk proposals, collect unit_ids where TAIL matches source_text or translated_text
   ```

2. **Backup before mutation** (REQUIRED):
   ```bash
   cp -r .rtl-state-w6/.../translations/proposals .rtl-state-w6/.../translations/proposals.bak-pre-fix
   ```

3. **For each polluted unit, derive clean values**:
   - Source: from original `.rpy` line. Extract the quoted text only:
     `me "W-what?" (multiple=2) with hpunch` → `"W-what?"`
   - Translation: match the model's intent, strip the same suffix.
     `Ч-что?" (multiple=2) with hpunch` → `Ч-что?`

4. **Apply via official domain API** (NOT ad-hoc JSON):
   ```python
   import hashlib
   from rtl_v4.domain.translation_models import TranslationProposal, TranslationValidation
   from rtl_v4.domain.translation_validator import validate_translation
   from rtl_v4.domain.tl_parser import tokenize_protected

   new_fp = hashlib.sha256(new_src.encode("utf-8")).hexdigest()
   new_tokens = tuple(tokenize_protected(new_src))
   val = validate_translation(source_text=new_src, translated_text=new_tgt, source_tokens=new_tokens)

   proposal = TranslationProposal(
       unit_id=uid,
       source_text=new_src,
       translated_text=new_tgt,
       model_id=raw.get("model_id"),
       context_fingerprint=raw.get("context_fingerprint", ""),
       source_fingerprint=new_fp,
       warnings=(),
       validation=TranslationValidation(passed=val.passed, flags=tuple(val.flags), errors=tuple(val.errors)),
       review=raw.get("review"),
   )
   out = proposal.model_dump(mode="json")
   out["_human_override_at"] = now_iso
   out["_human_override_reason"] = "..."
   ```

5. **Rebuild bundle** from on-disk files:
   ```python
   bundle = json.loads((PDIR/"proposals_russian.json").read_text())
   file_by_id = {f.stem: json.loads(f.read_text()) for f in PDIR.rglob("*.json")
                 if f.name not in ("manifest.json","proposals_russian.json")}
   bundle["proposals"] = [file_by_id.get(p["unit_id"], p) for p in bundle["proposals"]]
   ```

6. **Apply --retranslate** to overwrite TL with clean text:
   ```bash
   uv run rtl --state-root <abs> --game-root <abs> apply --retranslate
   ```

7. **Verify** with broad regex (NOT narrow):
   ```bash
   grep -nE 'multiple=' /path/to/tl/russian/*.rpy | grep -v ' #'
   ```
   All remaining `(multiple=N)` should be in CORRECT Ren'Py syntax
   (showparam OUTSIDE the closing quote, e.g. `me "Ч-что?" (multiple=2) with hpunch`).

8. **Lint must pass**:
   ```bash
   uv run rtl --state-root <abs> --game-root <abs> validate
   ```

## Why this works

- `apply.py` reads `p["translated_text"]` directly without validating
  `source_fingerprint` — confirmed via grep on apply.py. So source_text/
  fingerprint mutations are safe for apply, as long as translated_text is
  what we want in the TL.
- `validate_translation()` returns the same shape the runtime used, so the
  validation block stays consistent.
- `TranslationProposal.model_dump(mode="json")` produces the exact format
  translate.py writes, preserving schema compatibility.

## Common mistakes to avoid

1. **Narrow regex misses units**: a regex like `r'"[^"]*with dis[^"]*"'`
   catches `W-what?" with dissolve` but NOT `WHAT?!"` (no whitespace before
   closing `"`). Use a broader pattern covering `(multiple=N)`, `with <word>`,
   `с <cyrillic-word>`.
2. **Wrong unit_id identification**: polluting proposals may share source
   text across multiple scenes (e.g. `W-what?` appears in 2 different
   game locations, each with a DIFFERENT unit_id). Don't pick by source
   text only — verify each unit_id with proposal scan.
3. **Ad-hoc JSON mutation without schema**: writing JSON directly without
   the model_dump path may leave stale fields. Always go through
   TranslationProposal.model_dump.
4. **Skipping backup**: the fix overwrites files irreversibly. Always
   cp -r to a .bak-* directory before running.
5. **Forgetting audit**: write a before/after audit log so the change is
   traceable later.
