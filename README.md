# pi-tuning

Workspace for [pi](https://github.com/badlogic/pi-mono) extensions and configuration
tuning, ported from my oh-my-pi setup.

## Contents

- `extensions/todo/` — phased todo-list extension: `todo` tool with transcript
  persistence, sticky HUD widget, stop-time and mid-run reminders, eager prelude.
  Ported from oh-my-pi's built-in todo subsystem.

## Layout

Each extension is self-contained under `extensions/<name>/`: pure logic modules,
rendering, wiring entry (`index.ts`), prompt texts as `.md` files, and `bun test`
unit tests for the pure core.

## Install

Symlink an extension into the pi extensions directory:

```sh
ln -s "$PWD/extensions/todo" ~/.pi/agent/extensions/todo
```
