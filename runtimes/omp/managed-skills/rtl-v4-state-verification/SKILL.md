---
name: rtl-v4-state-verification
description: "How to check real translation-run state in rtl-v4 (proposal counts, residuals, status-command lies, fake-transport trap)"
---

Verifying actual rtl-v4 pipeline state (vs what `rtl status` or agent transcripts claim).

## Proposal coverage (correct counting)
Unit ids contain slashes/colons (`renpy-string:tl/russian/common.rpy:b1b13f33:0`), so files live in NESTED paths.

```python
from pathlib import Path
pdir = Path('.rtl-state/games/<game-key>/translations/proposals')
files = [f for f in pdir.rglob('*.json') if not f.name.startswith('proposals_') and f.name != 'manifest.json']
dlg = {f.stem for f in files if f.parent == pdir}   # dialogue ids have no slash → top-level only
passed = sum(1 for f in files if json.loads(f.read_text()).get('validation', {}).get('passed'))
```
- NEVER use top-level `glob('*.json')` for totals (misses all string units).
- NEVER compare `f.stem` to string unit_ids (stem drops directories) → false "all strings missing".
- Sanity check: dialogue_proposals + string_files == total files.

## Ground truth sources
- Applied count: lines in `translations/apply/journal.jsonl`.
- Validation: run `uv run rtl validate`; Ren'Py lint via `<renpy-sdk>/renpy.sh <game> . lint`.
- `rtl status` LIES about analysis/proposals/corpus: it reads `analysis/manifest.json` (`completed_work_items`, entries often `skipped`) and `translations/proposals/manifest.json`, neither of which translate/resume cycles refresh. Ignore its counts; compute from files.

## Known traps
- `bootstrap.py` silently substitutes FakeModelTransport when the API key is absent — `--real` can produce cached FAKE answers. Check key presence when output looks synthetic.
- tl_parser regexes must be escape-aware `((?:[^"\\]|\\.)*)` — greedy `(.*)"` leaks `with dissolve` clauses into source_text, which models echo back and break Ren'Py lint on apply (fixed in commit 74b3f61; keep it fixed).
- Known residual after the 2026-08-26 full run: ~41 stubborn dialogue units + ~109 failed string proposals (~0.5%); apply only writes `validation.passed` proposals.
