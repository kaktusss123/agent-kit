# Antigravity

Поддерживается глобальная установка рабочего процесса `agent-kit` в Google
Antigravity (CLI `agy`, App 2.0, IDE): общие навыки, правила общения и Git,
`/spec` и `/dev`, нативное делегирование субагентам, `agent-kit task` и
защитный `PreToolUse` hook.

```sh
git clone https://github.com/kaktusss123/agent-kit.git ~/src/agent-kit
~/src/agent-kit/bin/agent-kit install antigravity
```

Требуются Node.js >= 24 и `git`. Если `~/.local/bin` ещё не в `PATH`, добавьте
`export PATH="$HOME/.local/bin:$PATH"` в конфигурацию оболочки. После этого
работают `agent-kit status`, `agent-kit update` и `agent-kit uninstall antigravity`.

Корень конфигурации: `${ANTIGRAVITY_CONFIG_DIR:-$HOME/.gemini/config}`.
Состояние владения хранится в `$XDG_STATE_HOME/agent-kit/links-antigravity.tsv`.
Примечание: `agy plugin list` может отображать только `Components: 1 rule`,
даже когда `plugins/agent-kit/hooks.json` активно и блокирует `PreToolUse`.

## Что устанавливается

| Путь в `~/.gemini/config` | Источник | Назначение |
| --- | --- | --- |
| `skills/<name>` | `<repo>/skills/<name>` | Все общие навыки (`git-task`, `specification`, `implementation`, `code-review`, и др.) |
| `skills/spec` | `<repo>/antigravity/skills/spec` | Slash-команда `/spec` без префикса плагина |
| `skills/dev` | `<repo>/antigravity/skills/dev` | Slash-команда `/dev` без префикса плагина |
| `plugins/agent-kit/plugin.json` | `<repo>/antigravity/plugin/plugin.json` | Манифест плагина Antigravity |
| `plugins/agent-kit/rules/AGENTS.md` | `<state>/generated-antigravity/<sha256>-AGENTS.md` | Объединённые `rules/antigravity.md` + `rules/AGENTS.md` |
| `plugins/agent-kit/hooks.json` | `<state>/generated-antigravity/<sha256>-hooks.json` | `PreToolUse` routing guard (`antigravity/hook.ts`) |

Использование плагина для правил и hooks гарантирует отсутствие конфликтов с
пользовательскими `~/.gemini/config/hooks.json` и `~/.gemini/config/AGENTS.md`,
а также позволяет включать/выключать их через `agy plugin enable/disable agent-kit`.

## Защита маршрутизации и ограничения

`plugins/agent-kit/hooks.json` запускает `antigravity/hook.ts` на `PreToolUse`:

- Блокирует (`decision: "deny"`) файловые инструменты записи (`write_file`,
  `edit_file`, `write_to_file`, `replace_file_content`,
  `multi_replace_file_content`), если цель попадает в основной checkout
  репозитория, у которого есть управляемые task worktree, или в `.git`.
- Блокирует `run_command` с сырым `git ... --no-verify`.
- Для разрешённых вызовов выходит с кодом `0` и пустым stdout — не подменяет
  нативные разрешения и песочницу Antigravity.

PATH-shim для `git` в `run_command` намеренно не инжектируется, чтобы не ломать
Standard Sandbox Mode в других репозиториях (где каталог `agent-kit` недоступен
внутри песочницы). Управляемые worktree создаются в `~/.agent-kit/tasks` вне
рабочего каталога проекта, поэтому при первом `/spec` или `/dev` Antigravity
запросит подтверждение (`BypassSandbox: true`) для `agent-kit task` и команд
внутри worktree (либо добавьте правило для `~/.agent-kit/tasks` в `/permissions`).
Для мутирующих команд всегда используйте абсолютные пути управляемого
worktree, `git -C <worktree>` и `agent-kit task commit`.

## Проверки

```sh
node --test tests/antigravity/*.test.mjs
```
