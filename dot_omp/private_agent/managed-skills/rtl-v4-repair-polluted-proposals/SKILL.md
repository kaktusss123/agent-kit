---
name: rtl-v4-repair-polluted-proposals
description: "RTL v4: surgically fix parser-polluted proposal data using official domain API."
---

# RTL v4 — Repair polluted proposals via domain API

When the TL parser bug leaks metadata (e.g. `"(multiple=2) with hpunch"`) into `source_text`, the translator echoes it into `translated_text`. Repairing all units via re-translation is wasteful — mutate the affected units in-place using the official domain primitives.

## When to use

- Parser regression leaked metadata into `source_text` of proposals
- Affected units identified by source-text regex scan over `.rtl-state-w6/.../translations/proposals/`
- A targeted `rtl translate --unit-ids` command does NOT exist (no feature)

## Steps

1. **Identify affected units**: scan proposals with regex matching the pollution pattern:
   ```python
   TAIL = re.compile(
       r'\([^)]*multiple=[^)]*\)|'
       r'\([^)]*choice[^)]*\)|'
       r'\bwith\s+(?:dis|dissolve|Dissolve|hpunch|vpunch|fade)|'
       r'\bс\s+(?:dis|dissolve|hpunch|vpunch|fade|эффектом|растворени[ияе])'
   )
   ```

2. **For each affected unit, extract clean source from the original .rpy**:
   - Game source: `/path/to/game/game/<file>.rpy` lines like `me "W-what?" (multiple=2) with hpunch`
   - Clean source: just the quoted text `W-what?` (no showparam, no clause)

3. **Write a fix script using domain primitives**:
   ```python
   from rtl_v4.domain.translation_models import TranslationProposal, TranslationValidation
   from rtl_v4.domain.translation_validator import validate_translation
   from rtl_v4.domain.tl_parser import tokenize_protected

   def recompute_fingerprint(source_text: str) -> str:
       return hashlib.sha256(source_text.encode("utf-8")).hexdigest()

   new_fp = recompute_fingerprint(new_src)
   new_tokens = tuple(tokenize_protected(new_src))
   val = validate_translation(source_text=new_src, translated_text=new_tgt, source_tokens=new_tokens)

   proposal = TranslationProposal(
       unit_id=uid,
       source_text=new_src,
       translated_text=new_tgt,
       model_id=raw.get("model_id", "parser-fix-manual"),
       context_fingerprint=raw.get("context_fingerprint", ""),
       source_fingerprint=new_fp,
       warnings=(),
       validation=TranslationValidation(passed=val.passed, flags=tuple(val.flags), errors=tuple(val.errors)),
       review=raw.get("review"),
   )
   f.write_text(json.dumps(proposal.model_dump(mode="json"), ensure_ascii=False, indent=2))
   ```

4. **Backup proposals dir first** (`cp -r .../proposals .../proposals.bak`).

5. **Rebuild bundle from on-disk files** (existing CLI overwrote the bundle per run):
   ```python
   bundle = json.loads(BUNDLE_PATH.read_text())
   file_by_id = {f.stem: json.loads(f.read_text()) for f in PDIR.rglob("*.json") if f.name not in ("manifest.json", "proposals_russian.json")}
   new_proposals = []
   for p in bundle["proposals"]:
       uid = p["unit_id"]
       if uid in file_by_id:
           new_proposals.append(file_by_id[uid])
       else:
           new_proposals.append(p)
   bundle["proposals"] = new_proposals
   BUNDLE_PATH.write_text(json.dumps(bundle, ensure_ascii=False, indent=2))
   ```

6. **Apply with --retranslate**: `uv run rtl ... apply --retranslate` to overwrite non-empty targets with the cleaned translations.

7. **Lint + write audit**: save `clause_pollution_fix_audit.json` with before/after per unit, run `rtl validate`.

## Critical: validation consistency

- `apply.py` does NOT validate `proposal.source_fingerprint` against `source_text` (verified by grep — only stored in journal entries)
- `validation.passed` MUST remain True after mutation (re-run through `validate_translation()`)
- Schema: 11 required keys (`unit_id, source_text, translated_text, source_fingerprint, validation, model_id, context_fingerprint, created_at, warnings, review, _human_override_at`)

## Why this is safe

- Schema integrity preserved via `TranslationProposal.model_dump`
- Fingerprint consistency via `hashlib.sha256` matching `_compute_source_fingerprint` in `translate.py:726-730`
- Validation via official `validate_translation` matches runtime validation
- Audit trail in `_human_override_at` field (not part of schema, ignored by consumers)
