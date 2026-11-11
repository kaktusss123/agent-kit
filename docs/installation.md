# Установка и настройка

Начало работы с клонированием репозитория: [README](../README.md#быстрый-старт).
Нужны Node.js >= 24, `git` и отдельно установленный
[Pi](https://www.npmjs.com/package/@earendil-works/pi-coding-agent)
(пакет `@earendil-works/pi-coding-agent`), Claude Code или Codex CLI.
`bin/agent-kit` использует встроенные модули Node.js и работает без установки
пакетов. `agent-kit task` и hooks используют тот же Node.js; Bun не нужен.

## Выбор сред

Укажите среду явно при первой установке:

```sh
./bin/agent-kit install pi
./bin/agent-kit install claude-code
./bin/agent-kit install codex
```

Именованный `install` добавляет среды к сохранённому выбору. Последующие
`install` и `update` без аргументов работают с этим выбором, не трогая остальные
среды. Если выбора нет, `install` без аргументов устанавливает все три среды.
После удаления всех сред по одной поведение то же. Старые установки без
файла выбора сохраняют среды с существующими записями владения; к прежнему
выбору Pi/Claude Codex автоматически не добавляется.

```sh
agent-kit status
agent-kit install
agent-kit update
agent-kit uninstall claude-code
agent-kit uninstall
```

`update` выполняет `git pull --ff-only` в клоне и запускает обновлённый
установщик. `uninstall <host>` снимает принадлежащие установщику ссылки
среды и исключает её из выбора; без аргументов удаляет ссылки всех сред
и очищает выбор. Клон репозитория, лаунчер и `command.tsv` остаются.

## Куда устанавливаются файлы

| Источник | Pi: `~/.pi/agent` | Claude Code: `~/.claude` |
| --- | --- | --- |
| `skills/*` | `skills/*` | `skills/*` |
| `extensions/*` | `extensions/*` | нет |
| `prompts/*` | `prompts/*` | нет |
| `rules/AGENTS.md` | `AGENTS.md` | `rules/agent-kit.md` |
| `rules/claude-code.md` | нет | `rules/agent-kit-claude-code.md` |
| `claude-code/plugin` | нет | `skills/agent-kit` |
| `claude-code/commands/*` | нет | `commands/*` |
| `claude-code/agents/*` | нет | `agents/*` |

Корни можно изменить через `PI_AGENT_DIR` и `CLAUDE_CONFIG_DIR`.
Общие и специальные навыки Codex из `skills/*` и `codex/skills/*` ставятся
в `$HOME/.agents/skills`. Объединённые правила и hooks ставятся в
`${CODEX_HOME:-$HOME/.codex}`. `CODEX_HOME` не переносит навыки.
[Генерация файлов, владение и доверие Codex](codex.md).

Лаунчер `~/.local/bin/agent-kit` ссылается на `bin/agent-kit` выбранного клона.
Этот каталог должен быть в `PATH`. Если место лаунчера занято чужим файлом
или ссылкой, установщик лишь предупреждает и пропускает его; это само по себе
не даёт код 1. Успешная установка поэтому не гарантирует доступность команды.
Проверьте `./bin/agent-kit status` и предупреждения установщика.
Не рассчитывайте на `bin/` плагина Claude Code как на гарантированную запись
в `PATH`.

## Владение ссылками

Установщик хранит записи в `${XDG_STATE_HOME:-$HOME/.local/state}/agent-kit`:
`links.tsv` для Pi, `links-claude-code.tsv` для Claude Code,
`links-codex.tsv` и `links-codex-skills.tsv` для двух корней Codex.
`hosts` содержит выбор сред, `command.tsv` содержит владение лаунчером.

Операции удаления и перенаправления разрешены только для учтённой ссылки,
которая всё ещё указывает на записанный источник. Чужие файлы, личные навыки
и ссылки других инструментов сохраняются. Если их путь нужен установке,
`install` сообщает о конфликте и возвращает код 1; исключение для лаунчера
описано выше. Перенаправленная вручную
ссылка не становится собственностью agent-kit только из-за своего имени.
Исключение: существующий симлинк, который уже указывает ровно на нужный
источник в клоне, принимается во владение при `install` даже без прежней
записи. После этого `uninstall` может его удалить.

Повторный `install` из другого клона или worktree перенаправляет собственные
ссылки agent-kit на него. Храните клон на месте. Codex использует также
сгенерированные неизменяемые артефакты в каталоге состояния; изменения общих
правил требуют повторного `install` или `update`.

Перед сменой корней удалите ненужную установку в прежнем корне: установщик
не разыскивает старые корни. Детали: [ADR-0007](adr/adr-0007.md),
[ADR-0009](adr/adr-0009.md), [устройство установщика](adr/adr-0012.md).

## Pi

Установка подключает расширения и промпты, включая `/spec`, `/dev` и
`/neponel` для более простого пересказа предыдущего ответа. Откройте новую
сессию Pi после установки. [Справочник инструментов](workflow.md#инструменты-pi).

Поиск в интернете требует входа через `/login openai-codex`.
Роли моделей субагентов настраиваются через `/subagent-role`; быстрый выбор
модели самой сессии остаётся штатной настройкой Pi `enabledModels`.

## Claude Code

Правила из `~/.claude/rules/` подхватываются автоматически; личный
`CLAUDE.md` установщик не меняет. Общие навыки используют
[привязку к Claude Code](../rules/claude-code.md): `skill://<name>` означает
Skill tool, `ask` означает `AskUserQuestion`, task-инструменты вызываются
через `agent-kit task`.

Каталог `~/.claude/skills/agent-kit` содержит плагин, а не обычный навык:
у него нет `SKILL.md`. Claude Code загружает его как `agent-kit@skills-dir`,
без marketplace и ручной регистрации. Проверка: `claude plugin list`.
Установщик не пишет в `settings.json`.

Hooks плагина:

- `SessionStart` запускает `agent-kit task hook session-start`, включает
  Git shim для Bash сессии и субагентов, экспортирует `AGENT_KIT_POLICY`.
- `PreToolUse` для `Edit|Write|MultiEdit|NotebookEdit` вызывает
  `agent-kit task hook pre-tool-use`, защищая основной checkout от записи.

В Bash живой сессии проверьте окружение:

```sh
[ -n "$AGENT_KIT_POLICY" ] && echo guarded || echo unguarded
```

Управляемая настройка `allowManagedHooksOnly` может запретить hooks плагина,
даже если сам плагин загружен. Отсутствие hooks плагина в `hookInfos`
транскрипта не доказывает их неактивность: там перечисляются hooks настроек
сессии. Без плагина или окружения hooks могут пропускать проверки;
отсутствующий CLI в клоне также не превращает hooks в надёжный запрет.
Явный `agent-kit task` возвращает ошибку при невозможности работы.
Во всех случаях соблюдайте раздел
[Without the guard](../skills/git-task/references/claude-code/task-workspace.md).
Защита маршрутизации не заменяет песочницу.

Роли задаются в `claude-code/agents/`: `explore` использует `Explore`
с `model: haiku`, `effort: low` и Read/Grep/Glob; `owner` использует
`repo-owner` с `model: sonnet`, `effort: medium`. Для `review` вызывается
`general-purpose` с `model: opus`, для `helper` тот же тип без подмены модели.
Новый тип нужен ради собственных инструкций или инструментов, не ради цены.
[Роли и алиасы моделей](adr/adr-0011.md).

Необязательный фрагмент пользовательского `~/.claude/settings.json`,
задающий effort по моделям:

```json
{
  "modelSettings": {
    "claude-haiku-5-5": { "autoCompactWindow": 130000, "effortLevel": "high" },
    "claude-sonnet-5-5": { "effortLevel": "medium" },
    "claude-opus-5-5": { "effortLevel": "medium" }
  }
}
```

Алиасы можно переопределить переменными `ANTHROPIC_DEFAULT_HAIKU_MODEL`,
`ANTHROPIC_DEFAULT_SONNET_MODEL`, `ANTHROPIC_DEFAULT_OPUS_MODEL`; замена общая
для алиаса, не отдельной роли. `effort` агента перекрывает effort сессии,
но не `CLAUDE_CODE_EFFORT_LEVEL`. Применение `ANTHROPIC_DEFAULT_*` к алиасу
во frontmatter субагента остаётся вопросом эмпирической проверки в
[ADR-0011](adr/adr-0011.md).

В sandbox-режиме Bash сетевые операции с учётными данными и недоступные
операции над task root передаются пользователю готовой командой `! …`.
Ограничения протокола: [ADR-0008](adr/adr-0008.md).

## Миграция прежних установок

Новая установка не требует миграции. Внешние корпоративные ресурсы в этот
репозиторий не входят. Прежний `--profile full` отклоняется с кодом 2
до изменения состояния или pull; без флага и с `--profile core` набор одинаков.

Для старой full-установки сначала завершите передачу корпоративных ссылок
и владения отдельной поставке, **до pull и старого `agent-kit update`**.
Откат тоже требует согласованного комплекта кода, конфигурации и владения,
не просто запуска старого установщика. [Полная процедура](split-plan.md).
