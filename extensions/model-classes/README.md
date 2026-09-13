# model-classes

Saved model + thinking shortcuts for Pi. Exactly three classes:

| Class     | Meaning                                                  | Persisted |
| --------- | -------------------------------------------------------- | --------- |
| `default` | The current session model + thinking, always a live snapshot | never |
| `cheap`   | User-saved model + thinking pair                          | yes       |
| `smart`   | User-saved model + thinking pair                          | yes       |

`default` is not a profile: it is whatever Pi is running right now. After
`/model-class smart` applies the saved `smart` pair, that pair automatically
IS the new `default`. There is no active-class marker; `default`, `cheap`
and `smart` may be equal without warnings.

## Commands

```text
/model-class                     status + usage
/model-class <cheap|smart>       switch this session to the saved pair
/model-class <cheap|smart> set   persist the current pair into the class
```

That is the whole contract. No `/model-class default`, no help, no reset:
the bare command is the reference. Examples:

```text
/model-class            →  Model classes
                           default  openai-codex/gpt-5.6-sol       high
                           cheap    cloudru/openai/gpt-oss-120b    medium
                           smart    not set
                           Usage: ...
/model-class cheap set  →  Saved cheap: cloudru/openai/gpt-oss-120b, medium
/model-class cheap      →  Switched to cheap: cloudru/openai/gpt-oss-120b, medium
```

`set` snapshots the pair currently selected in the session (no manual
identifier typing) and never changes the session. It overwrites an existing
saved class without confirmation. `switch` resolves the saved model through
the normal Pi registry and applies model + thinking together.

## Guarantees

- **No partial switch.** The whole target combination (model exists, saved
  thinking supported by it) is validated before anything is applied; the
  effective thinking level is verified afterwards, and a mismatch restores
  the previous pair.
- **No fallback.** A class that was never configured, a model that is gone
  from the registry, or an unsupported thinking level all fail with an
  error. Never falls back to `default`, another provider, or a lower
  reasoning level; the session stays unchanged.
- **Atomic persistence.** `<agent-dir>/model-classes.json` (honors
  `PI_CODING_AGENT_DIR`) is written tmp+rename; a failed write reports an
  error and never claims success. Machine-local file, not part of agent-kit.
  Concurrent `set` from two Pi sessions is last-writer-wins per whole file
  (no cross-process locking — deliberate, for a rarely-changed setting).

## Subagent integration

The `subagent` tool's spawn op takes `modelClass?: "cheap" | "default" |
"smart"` (default `"default"`) instead of raw `model`/`thinking`: concrete
provider/model and thinking are resolved by the shared resolver in `core.ts`
at spawn time, before the child process starts — an unresolved class never
starts a child. The runtime boundary below (`SpawnOptions`) keeps concrete
`model` + `thinking`, because the child process needs literal CLI flags.
Resolution shares this extension's storage file; the two extensions are
separate jiti entries, so sharing happens at the module level, not through
extension state.
