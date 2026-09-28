# model-classes

Named model + thinking classes for Pi, plus per-spawn-mode routing.

| Concept   | Meaning                                                       | Persisted |
| --------- | ------------------------------------------------------------- | --------- |
| `default` | The current session model + thinking, always a live snapshot  | never     |
| `<class>` | A user-named model + thinking pair (any number of them)       | yes       |
| `routing` | Spawn-mode defaults: which class `plain`/`repoOwner` children run on | yes |

`default` is not a profile: it is whatever Pi is running right now. After
`/model-class heavy` applies the saved `heavy` pair, that pair automatically
IS the new `default`. There is no active-class marker; any two classes (or a
class and `default`) may be equal without warnings.

Class names are 1–32 chars — a lowercase letter, then lowercase letters,
digits, or dashes (`/^[a-z][a-z0-9-]{0,31}$/`). The words `default`,
`inherit`, `route`, `next`, `set`, `unset`, `routing` are reserved and
cannot be class names. Old storage containing only `cheap`/`smart` loads
unchanged: those are ordinary class names now.

## Commands

```text
/model-class                                  status + usage
/model-class <class>                          switch this session to the saved pair
/model-class <class> set                      persist the current pair into the class
/model-class <class> unset                    delete the class (refused while routed)
/model-class next                             cycle to the next saved class
/model-class route                            show the routing table
/model-class route <plain|repoOwner> <class|inherit>
                                              set/reset a spawn mode's default
```

Examples:

```text
/model-class                     →  Model classes

                                    default    zai/glm-x    low
                                    workhorse  cloudru/openai/gpt-oss-120b    medium
                                    heavy      openai-codex/gpt-5.6-sol       high

                                    Routing (spawn-mode defaults)

                                    plain      workhorse  (cloudru/openai/gpt-oss-120b, medium)
                                    repoOwner  heavy      (openai-codex/gpt-5.6-sol, high)

                                    Usage: ...
/model-class workhorse set       →  Saved workhorse: cloudru/openai/gpt-oss-120b, medium
/model-class workhorse           →  Switched to workhorse: cloudru/openai/gpt-oss-120b, medium
/model-class route plain workhorse →  Routing plain: workhorse (cloudru/openai/gpt-oss-120b, medium)
/model-class route plain inherit   →  Routing plain: inherit (session pair)
/model-class next                →  Switched to heavy: openai-codex/gpt-5.6-sol, high
```

`set` snapshots the pair currently selected in the session (no manual
identifier typing) and never changes the session. It overwrites an existing
saved class without confirmation. `unset` deletes a class and refuses while
any routing entry references it, naming the modes to reset first.
`route <mode> <class>` validates that the class is saved at set time;
`inherit` resets the mode to session inheritance. `next` (and Ctrl+Alt+P)
cycle forward through saved classes in storage order — see below.

## Cycling (Ctrl+Alt+P, `/model-class next`)

Stateless forward cycling: if the live session pair (model AND thinking)
equals a saved class's pair, switch to the next class in storage order
(wrap around); if it equals none, switch to the first class; zero saved
classes → informative error, nothing changes. No "active class" is persisted
anywhere — the live model is the only source of truth. The switch reuses the
validated apply path (no mixed model/thinking states) and the shortcut
notifies with the applied class + pair.

## Spawn-mode routing

The `subagent` tool's spawn op takes `modelClass?: string` — valid for BOTH
plain (`cwd`) and workspace (`workspace=`) spawns. One resolution matrix
(SPEC R3); the spawn mode only selects the routing default:

| modelClass param     | Resolution                                                        |
| -------------------- | ----------------------------------------------------------------- |
| `"default"`          | live session pair (escape hatch, both modes)                      |
| a saved class name   | its stored pair, validated against the registry (override)        |
| anything else        | fail closed; the error lists the saved class names                |
| omitted + route set  | the routed class, resolved and validated identically (fail closed)|
| omitted + no route   | live session pair (plain spawns: today's behavior; workspace: the pre-dispatch no-model gate still applies) |

A route that references a missing class or a dead model fails closed at
spawn time with an error naming the class, the mode, and the fix
(`/model-class route <mode> <class|inherit>` or re-save the class). On
workspace spawns such failures classify as `blocked` (`dispatched:false`,
nothing started) — a Main-side config problem, not a profile failure.

Routing is machine-global (agent dir), not per-project. Scope note: routing
applies by spawn mode regardless of who spawns — a RepoOwner spawning a
plain helper without `modelClass` gets the `plain` route; `modelClass:
"default"` is the explicit way to match the parent's model.

## Guarantees

- **No partial switch.** The whole target combination (model exists, saved
  thinking supported by it) is validated before anything is applied; the
  effective thinking level is verified afterwards, and a mismatch restores
  the previous pair.
- **No fallback.** An unsaved class, a model that is gone from the registry,
  or an unsupported thinking level all fail with an error. Never falls back
  to `default`, another provider, or a lower reasoning level; the session
  (or the spawn) stays unchanged.
- **Atomic persistence.** `<agent-dir>/model-classes.json` (honors
  `PI_CODING_AGENT_DIR`) is written tmp+rename; a failed write reports an
  error and never claims success. Corrupt JSON aborts every write (`set` /
  `route` / `unset` never replace state they could not read) and throws to
  readers. Machine-local file, not part of agent-kit. Concurrent writes from
  two Pi sessions are last-writer-wins per whole file (no cross-process
  locking — deliberate, for a rarely-changed setting).
- **Storage order is the cycling order.** Classes keep JSON key insertion
  order; there is no reorder UI.
