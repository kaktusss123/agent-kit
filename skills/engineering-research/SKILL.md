---
name: engineering-research
description: "Primary-source technical research for APIs, frameworks, dependencies, standards, runtime behavior, and uncertain engineering facts. Use in ordinary chat, plan mode, task discovery, debugging, or implementation when local evidence is insufficient and exact versions or authoritative external behavior matter."
---

# Engineering research

Resolve engineering facts from the strongest source available.

## Source order

For software behavior, prefer:
1. installed or vendored exact version;
2. source/tag/release matching that version;
3. official documentation or specification;
4. upstream current source when version-specific material is unavailable;
5. secondary sources only for leads or community experience.

For rungs 3-5, use the `web_search` tool when available instead of answering current-behavior questions from memory: one query per call, prefer primary sources, cite the source URLs you relied on.

Distinguish public supported API from internal implementation details.

## Research discipline

State the exact question before broad searching. Follow important claims back to the source that owns them. Record versions, dates, flags, and environment assumptions that change the answer.

If sources disagree, preserve the disagreement and explain which one governs the target environment.

Do not require a background agent. The current agent may research directly or delegate if the host provides a useful mechanism.

## Output

Return the answer, evidence links/pointers, confidence/limitations, and concrete implication for the engineering decision being made.
