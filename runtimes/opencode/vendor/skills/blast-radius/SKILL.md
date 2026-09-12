---
name: blast-radius
description: "Find non-obvious downstream breakage from a code or contract change, including callers, persistence, compatibility, lifecycle, integration, and operational effects."
---

# Blast radius

Start from the behavior or contract that changes. Trace direct callers and callees, then check indirect dependencies that can break without a direct reference.

Consider public and internal APIs, schemas, serialized data, persistence, migrations, caches, retries, lifecycle transitions, concurrency, configuration, metrics, and tests when relevant.

Do not enumerate every category. Follow the actual dependency graph of the change. Report concrete affected consumers and the evidence that connects them to the changed contract.
