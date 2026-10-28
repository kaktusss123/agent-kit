# Known traps

## Calendar-day e2e fixtures

E2e fixtures comparing LOCAL calendar days break in the first hour after local
midnight on UTC runners: "an hour ago" reads as yesterday, and any "today at
<fixed future time>" seed sorts above real events in newest-first orders. Seed
`max(now - N, local-midnight)` and share the constant with time-format
assertions.
