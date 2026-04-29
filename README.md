# OpenCode

Runtime-конфиги агентов, команд и скиллов для OpenCode.

## Что такое OpenCode

OpenCode — консольный менеджер LLM и MCP, направленный на написание кода через промпты и инструменты. Он работает в терминале (TUI), поэтому для работы рекомендуется использовать современный терминал:

- [Kitty](https://sw.kovidgoyal.net/kitty/) — разрешён ЦКЗ, рекомендуется ([пример конфига](https://github.com/zsxoff/dotfiles/blob/main/kitty/kitty.conf))
- [Ghostty](https://ghostty.org/) — разрешён ЦКЗ, нативный интерфейс для macOS
- [Alacritty](https://alacritty.org/) — разрешён ЦКЗ, не имеет встроенных вкладок ([пример конфига](https://github.com/zsxoff/dotfiles/blob/main/alacritty/alacritty.toml))
- [WezTerm](https://wezterm.org/) — разрешён ЦКЗ, сложнее в настройке (конфиг на Lua)

## Официальная документация

- Основная документация: <https://opencode.ai/docs/>
- Установка OpenCode: <https://opencode.ai/docs/#install>
- Провайдеры и модели: <https://opencode.ai/docs/providers/#custom-provider>

## Базовая установка OpenCode

```bash
brew install opencode
```

После установки настройте провайдера и модели по официальной документации, затем откройте проект и запустите `opencode`.

## Что в этом репозитории

Готовые конфиги для копирования в `~/.config/opencode/`:

- **Агенты** — runtime-определения агентов (primary — пользовательские оркестраторы, subagents — специализированные воркеры).
- **Команды** — слэш-команды (`/commit`, `/spec-discovery`).
- **Скиллы** — инструкции для специализированных workflows.

## Структура

```
OpenCode/
├── agents/
│   ├── primary/          # Пользовательские оркестраторы
│   └── subagents/        # Специализированные воркеры (делегируются primary)
├── commands/             # Слэш-команды
├── skills/               # Скиллы с инструкциями и references/
└── README.md
```

Primary-агенты взаимодействуют с пользователем напрямую и делегируют подзадачи subagent-ам. Subagent-ы не вызываются пользователем напрямую — они выполняют конкретные задачи по запросу primary-агентов.

## Агенты

### Primary

| Агент | Назначение |
|-------|-----------|
| `full-spec-analyst` | Комплексное обнаружение и написание спецификаций для сложных фич |

### Subagents

| Агент | Назначение |
|-------|-----------|
| `committer` | Создание безопасного git-коммита с conventional message и pre-commit хуками |
| `contract-impact-auditor` | Аудит влияния фичи на API, события, схемы, очереди, persistence, контракты |
| `design-planner` | Планирование дизайна, trade-off анализ, execution sequencing |
| `edge-case-harvester` | Систематический перебор edge-кейсов, негативных сценариев, конфликтных состояний |
| `feature-triager` | Фрейминг задач, уточнение скоупа и требований, kanban-first тиражирование |
| `non-functional-prober` | Анализ нефункциональных требований: производительность, надёжность, безопасность, observability |
| `repo-scout` | Разведка репозитория, реконструкция поведения системы, поиск точек влияния |
| `traceability-checker` | Проверка полноты и трассируемости спецификаций (цели → сценарии → требования → тесты) |

## Команды

| Команда | Назначение |
|---------|-----------|
| `commit` | Создание git-коммита в conventional формате с pre-commit хуками |
| `spec-discovery` | Запуск процесса discovery спецификаций через workspace-based анализ |

## Скиллы

| Скилл | Назначение |
|-------|-----------|
| `contract-impact-audit` | Аудит влияния фичи на внутренние и внешние контракты |
| `delegation-context` | Обеспечение полной передачи контекста при делегировании сабагентам |
| `design-brief` | Формирование дизайн-брифа с анализом trade-off и секвенированием реализации |
| `edge-case-harvest` | Систематический перебор edge-кейсов, негативных сценариев, деградационных режимов |
| `execution-plan` | Планирование реализации с шагами, зависимостями и рисками |
| `feature-interrogation` | Структурированное уточнение требований, скрытых ожиданий и acceptance criteria |
| `git-commit` | Workflow для генерации conventional commit messages |
| `kanban-discipline` | Дисциплина работы с kanban: обновление статусов, связей, решений |
| `non-functional-probe` | Анализ нефункциональных требований: производительность, надёжность, безопасность |
| `repo-reconnaissance` | Разведка репозитория: поиск модулей, паттернов, точек влияния |
| `spec-discovery` | Обнаружение и первичный анализ пространства спецификаций |
| `spec-synthesis` | Синтез итоговой спецификации из артефактов: сценарии, требования, acceptance criteria |
| `task-workspace` | Инициализация и поддержка task-scoped workspace для фичи или change request |
| `traceability-check` | Проверка полноты и трассируемости спецификаций |

## Conventions

- **Агенты**: `agents/primary/<name>/` — пользовательские оркестраторы, содержат `<name>.md`; `agents/subagents/<name>/` — специализированные воркеры, содержат `<name>.md`.
- **Команды**: `commands/<name>/` — содержит `<name>.md`.
- **Скиллы**: `skills/<name>/` — содержит `SKILL.md` и опционально `references/` с дополнительными конфигами и шаблонами.

## Установка

Скопировать нужные директории в `~/.config/opencode/`:

```bash
cp -r OpenCode/agents ~/.config/opencode/agents
cp -r OpenCode/commands ~/.config/opencode/commands
cp -r OpenCode/skills ~/.config/opencode/skills
```

## Подключение моделей Foundation Models

> [!tip]
> Официальная документация по подключению провайдеров: <https://opencode.ai/docs/providers/#custom-provider>

Для начала работы необходимо добавить в конфиг OpenCode провайдер и модель Foundation Models.

В файл `~/.config/opencode/opencode.json` добавить:

```json
{
  "$schema": "https://opencode.ai/config.json",
  "provider": {
    "cloudru": {
      "npm": "@ai-sdk/openai-compatible",
      "name": "Cloud.ru Foundation Models",
      "options": {
        "baseURL": "https://foundation-models.api.cloud.ru/v1"
      },
      "models": {
        "Qwen/Qwen3-Coder-480B-A35B-Instruct": {
          "name": "Qwen3-Coder-480B-A35B-Instruct"
        }
      }
    }
  }
}
```

После добавления конфигурации откройте любой проект и выполните `opencode`. В интерфейсе OpenCode выполните `/connect`, выберите провайдера `Cloud.ru Foundation Models` и введите API-ключ от песочницы Блока разработки.

Выбор модели зависит от задач: быстрые модели для рутинных операций (коммиты, простые ревью), более мощные — для глубокого анализа и генерации сложных спецификаций.

## Git commit workflow

Воркфлоу для автоматизированного коммита реализован через скилл `git-commit` и сабагент `committer`. Подробнее: [`skills/git-commit/SKILL.md`](skills/git-commit/SKILL.md).

## Тюнинг параметров моделей Foundation Models

TODO (<https://wiki.cloud.ru/x/-e5PJg>)

## Подключение MCP

Для работы с kanban (используется в скиллах `kanban-discipline` и агентах `feature-triager`, `design-planner`, `full-spec-analyst`):

```bash
curl -fsSL https://raw.githubusercontent.com/multidimensionalcats/kanban-mcp/main/install.sh | bash
```

Добавить в `~/.config/opencode/opencode.json`:

```json
{
  "$schema": "https://opencode.ai/config.json",
  "mcp": {
    "kanban": {
      "type": "local",
      "command": ["kanban-mcp"],
      "environment": {
        "KANBAN_DB_HOST": "localhost",
        "KANBAN_DB_USER": "kanban",
        "KANBAN_DB_PASSWORD": "changeme",
        "KANBAN_DB_NAME": "kanban"
      }
    }
  }
}
```

При отсутствии kanban MCP скилл `kanban-discipline` автоматически переключается на file-based логирование в `decision-log.md`.

Документация kanban-mcp: <https://github.com/multidimensionalcats/kanban-mcp/>  
Подробнее о MCP в OpenCode: <https://opencode.ai/docs/mcp-servers/>
