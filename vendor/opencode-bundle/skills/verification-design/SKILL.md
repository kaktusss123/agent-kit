---
name: verification-design
description: "Choose the smallest trustworthy checks that can observe a software change and its important failure modes."
---

# Verification design

Map each important requirement to evidence that can actually observe it.

Prefer the narrowest useful test or reproduction first. Broaden to package, integration, lint, typecheck, build, or manual runtime checks when the risk or contract requires them.

Do not treat a command as proof for behavior it cannot observe. Include important failure paths and compatibility seams when they are part of the requested change.
