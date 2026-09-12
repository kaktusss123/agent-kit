---
name: change-verification
description: "Fresh-context verification of an exact checkpoint commit against its intended behavior and repository constraints."
---

# Change verification

Verify a fixed checkpoint. Do not repair it in the same pass.

Establish the commit or exact diff, its base, and the intended slice acceptance. Inspect the actual committed change and enough surrounding code to understand its effects.

Use `verification-design` for executable evidence and `code-review` for independent review. Add `blast-radius` or `security-review` only when the change warrants them.

Return `PASS` only when the committed state satisfies the slice and no blocking defect is supported by the available evidence.

A blocking finding must state the observed defect, the violated requirement or invariant, concrete evidence, and the correction direction. Keep optional suggestions separate.
