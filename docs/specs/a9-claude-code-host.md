# A9: Claude Code как полноценный host agent-kit

Status: Draft
Основание: [ADR-0007](../adr/adr-0007.md) (один checkout → несколько hosts). Этот документ — контракт оставшейся работы, а не повтор ADR.

## Проблема и желаемый результат

После ADR-0007 Claude Code получает skills и правила agent-kit, но не получает его deterministic runtime: task workspace, mutation guard, checkpoint commit, RepoOwner-оркестрацию и workflow entrypoints `/spec` и `/dev`. В результате в Claude Code работа идёт в текущем checkout'е без защиты, ради которой эти механизмы существуют в Pi.

Желаемый результат: в Claude Code доступен тот же task workflow — task identity, managed worktree как «дом» исполнителя, защита primary checkout'а, проверяемый commit — без второй копии policy и без регрессий в Pi. Через какие механизмы (CLI, hooks, worktree-примитивы Claude Code) — решается в рамках этой работы, но с ограничениями ниже.

## Ограничения и инварианты

- **Одна копия.** Semantic policy (`SKILL.md`) общая для всех hosts. Host-специфичны только operating contracts (`references/`), entrypoints и runtime-обвязка.
- **Pi не регрессирует.** Существующие Pi extensions, их контракты и тесты продолжают работать без изменений поведения.
- **Без MCP.** Корпоративная политика разрешает только одобренные MCP-серверы. Deterministic-операции для Claude Code поставляются как CLI с машиночитаемым (JSON) выводом и стабильными статусами, вызываемый через Bash, и как hooks.
- **Переносимость путей.** Конфигурация host ссылается только на пути, которые инсталлер создаёт внутри корня host. Никаких путей к checkout'у или к каталогу другого host.
- **Ownership-модель инсталлера** (ADR-0007, README) распространяется на всё, что ставится в новые места: только symlinks, только собственные ссылки, конфликт вместо перезаписи. Real files пользователя (например, `~/.claude/settings.json`) инсталлер не редактирует.
- **Host-независимое ядро.** Логика task-workspace (`flows`, `git`, `guard`, `current`, git shim policy) остаётся одним кодом для Pi extension и для CLI; Pi extension становится тонкой обёрткой над тем же ядром, а не параллельной реализацией.
- **Guard — routing protection, не sandbox** (как в Pi): задокументированные обходы допустимы, ложные блокировки prose недопустимы.

## Подтверждённые решения

- **D1.** Один фреймворк для Pi и Claude Code, позже OpenCode; без downstream-копии. Реализовано на уровне установки (ADR-0007).
- **D2.** Custom tools для Claude Code — CLI, не MCP (D-ограничение «Без MCP»).
- **D3.** Ядро task-workspace выносится в общее, потребители — Pi extension и CLI.
- **D4.** RepoOwner в Pi — вынужденный механизм, чтобы исполнитель считал managed worktree своим «домом» и не тянулся к primary checkout. В Claude Code RepoOwner не переносится по умолчанию: сначала проверяется, решают ли ту же задачу штатные примитивы (см. W2). Перенос протокола — только если эксперимент это опровергнет.

## Работы

### W0. `agent-kit update` применяет свежий инсталлер

Сейчас `update` после `git pull` вызывает reconcile функциями, загруженными до pull: новые hosts или изменённая логика применяются только со следующего запуска (наблюдалось при обновлении на ADR-0007: секция `claude-code` не выполнилась).

Контракт: после успешного pull reconcile выполняется кодом из обновлённого checkout'а.

Приёмка: checkout, где pull приносит новый host в инсталлер; один `agent-kit update` создаёт ссылки этого host. Отказ pull по-прежнему не запускает reconcile.

### W1. Task-workspace CLI

Публичная поверхность — подкоманды `agent-kit` (или отдельного бинаря, ставящегося инсталлером в собственный путь), эквивалентные Pi-инструментам: статус и классификация пути, ensure task repo (включая lanes и выбор base/remote), удаление lane, checkpoint commit (включая deferred hook evidence). Входы и статусы совпадают с контрактами `skills/git-task/references/task-workspace.md` и `skills/git-commit/references/checkpoint.md`: те же meaningful statuses, те же отказы угадывать (`base_selection_required`, `remote_selection_required`, `branch_in_use`), те же гарантии (не force, не reset, protected branches отклоняются).

Вывод — JSON на stdout; код выхода отличает «операция выполнена с meaningful status» от «ошибка инструмента».

Приёмка:
- ensure для новой task branch в репозитории без task branch и без `base_ref` → `base_selection_required`, ничего не создано.
- повторный ensure той же task identity → `reused`, тот же путь.
- checkpoint commit в primary checkout без явного разрешения → `primary_commit_blocked`, commit не создан.
- checkpoint commit с путём, похожим на секрет → `secret_path_rejected`.
- те же сценарии через Pi extension дают идентичные статусы (общее ядро).

### W2. Worktree как «дом» исполнителя в Claude Code (эксперимент → решение)

Кандидаты (по документации Claude Code, не проверено на практике):
- hook `WorktreeCreate` заменяет создание worktree штатного `claude --worktree` / `isolation: worktree`: получает branch/commit, печатает путь — может делегировать в ensure task repo;
- инструмент `EnterWorktree(path)` переносит текущую сессию в существующий worktree;
- субагенты с `isolation: worktree` получают встроенный отказ git/команд, адресованных в main checkout.

Эксперимент должен ответить:
- **Q1.** Может ли `WorktreeCreate` вернуть уже существующий канонический worktree задачи (reuse), и как не дать `WorktreeRemove`/автоочистке удалить его.
- **Q2.** Подхватывает ли сессия/субагент `CLAUDE.md` и project instructions worktree'а.
- **Q3.** Как работает multi-repo задача: несколько worktrees, у субагента `cd` не сохраняется между вызовами.
- **Q4.** Чем заменяются гарантии RepoOwner, которые нужны на самом деле: проверка settled state после `done` (кандидат — `SubagentStop` hook с отказом при грязном дереве), `git_facts`, вопрос к Main вместо `needs_input` (субагент не может спрашивать пользователя; Main продолжает его через `SendMessage`), дедлайн (есть только `maxTurns`).

Результат — ADR с выбранным механизмом. Приёмка механизма: исполнитель, запущенный на задачу, делает изменения и commit только в managed worktree; попытка мутации primary checkout'а блокируется с указанием worktree; Main получает объективные git-факты результата, а не пересказ модели.

### W3. Mutation guard в Claude Code

Тот же git shim и та же policy, что в Pi. Активация — hook начала сессии, который через `CLAUDE_ENV_FILE` ставит shim первым в PATH и задаёт guard-окружение; файловые записи (`Edit`/`Write`) в primary checkout репозитория с managed worktrees отклоняются `PreToolUse` hook'ом. Если W2 выберет `isolation: worktree`, guard дополняет встроенную защиту, а не дублирует её.

Приёмка:
- в репозитории с managed worktree `git commit` в primary checkout через Bash блокируется с указанием worktree; `git status` проходит.
- `git commit --no-verify` блокируется везде.
- `Edit` файла primary checkout'а такого репозитория отклоняется с причиной; в репозитории без managed worktrees ничего не блокируется.
- без guard-окружения shim fail-open (как в Pi).

### W4. Доставка hooks

Hooks живут в `settings.json` или в plugin; инсталлер не правит real files пользователя. Нужно решение (см. U1). Приёмка: после `agent-kit install` hooks W3 активны в новой сессии Claude Code без ручного редактирования `settings.json`, а `agent-kit uninstall` их снимает.

### W5. Host-специфичные references и entrypoints

- `git-task` и `git-commit` получают Claude Code variant operating contracts (CLI вместо Pi-инструментов, механизм W2 вместо `subagent workspace`), при общем `SKILL.md`. После этого снимается `metadata.hosts: pi`. Механика выбора references per host — часть этой работы (инсталлер уже различает hosts).
- `/spec` и `/dev` в Claude Code: тонкие entrypoints, связывающие те же skills; ставятся инсталлером в собственный путь host'а. `/dev` описывает оркестрацию через механизм W2.
- `rules/claude-code.md` сокращается по мере появления runtime: оговорка «runtime недоступен» убирается для того, что стало доступно.

Приёмка: в Claude Code `/spec <задача>` создаёт или переиспользует task workspace и пишет `SPEC.md` в нём; `/dev` реализует по нему в managed worktree с commit'ом и проверкой; в Pi поведение `/spec` и `/dev` не меняется.

### W6. Скрипты skills, адресуемые относительно skill-директории

`lazy-mr-review` и `editorial-html-report` вызывают `scripts/...` относительным путём. В Claude Code cwd — проект пользователя. Нужен способ, работающий в обоих hosts (Claude Code поддерживает `${CLAUDE_SKILL_DIR}`; Pi — проверить). Приёмка: оба skill'а находят свои скрипты из произвольного cwd в обоих hosts.

## Нерешённое

- **U1. Доставка hooks (W4):** локальный Claude Code plugin в репозитории (hooks + `bin/`), регистрируемый инсталлером через CLI Claude Code, против ссылки на hooks-файл, подключаемый одной строкой в `settings.json` пользователем вручную. Plugin `bin/` к тому же решает доставку CLI в PATH.
- **U2. Корпоративная политика на рабочей машине:** разрешены ли пользовательские plugins/marketplaces и hooks (`strictKnownMarketplaces`, `allowManagedHooksOnly` и подобные). Если hooks запрещены, W3 неосуществим в Claude Code — тогда защита сводится к W2. Проверить до W3/W4.
- **U3.** Результат эксперимента W2 определяет форму `/dev` и судьбу RepoOwner-протокола в Claude Code.
- **U4.** OpenCode как третий host — вне этой работы; инсталлер и разделение references не должны его исключать.

## Вне scope

- MCP-серверы.
- Перенос Pi-UX расширений (`footer`, `todo`, `ask`, `web-search`, `perf-stats`, `session-title`, `continue-shortcut`, `agent-events`, `proxy-toggle`, `update-check`, `model-classes`) — у Claude Code свои штатные аналоги или они не нужны.
- Изменение Pi-поведения сверх выноса ядра.

## Риски

- Ложные блокировки guard'а в Claude Code из-за отличий исполнения Bash (иной shell snapshot, сброс cwd) — guard обязан оставаться fail-open без своего окружения.
- Worktree-примитивы Claude Code эволюционируют; механизм W2 фиксируется ADR с указанием проверенной версии.
- Персональные `code-review`/`security-review` заменяют встроенные команды Claude Code — осознанное следствие ADR-0007.
