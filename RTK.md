# RTK - Rust Token Killer

**Usage**: Token-optimized shell proxy for OpenCode bash calls.

## Meta Commands

Use `rtk` directly for RTK-specific commands:

```bash
rtk gain
rtk gain --history
rtk discover
rtk proxy <cmd>
```

## Verification

```bash
rtk --version
rtk gain
which rtk
```

## OpenCode Integration

Regular `bash` tool commands are rewritten automatically by the OpenCode plugin.
Example: `git status` -> `rtk git status`.

If `rtk gain` fails, check for a conflicting `rtk` binary.
