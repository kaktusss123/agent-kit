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
или
```bash
curl -fsSL https://opencode.ai/install | bash
```

После установки настройте провайдера и модели по официальной документации, затем откройте проект и запустите `opencode`.

## Автообновление после `git pull`

После первого запуска установите versioned hooks и создайте managed symlinks:

```bash
./scripts/enable-hooks.sh
```

Далее `post-merge` после успешного `git pull` запускает `scripts/install.sh` только для уже установленного bundle.
Ошибка обновления ссылок выводится как предупреждение и не отменяет успешный pull.

## Что в этом репозитории

Готовые конфиги агентов, команд и скиллов для установки через симлинки в `~/.config/opencode/`:

- **Агенты** — runtime-определения агентов (primary — пользовательские оркестраторы, subagents — специализированные воркеры).
- **Команды** — слэш-команды (`/commit`, `/init`, `/feedback`, `/spec`, `/spec-lite`, `/execute-spec`, `/test`, `/analyze`).
- **Project docs templates** — локальные артефакты проекта, такие как `docs/feedback/README.md`, которые копируются в целевые репозитории.
- **Скиллы** — инструкции для специализированных workflows.
- **opencode.example.jsonc** — базовый конфиг (Cloud.ru FM + назначения моделей агентам).
- **scripts/** — установщик (`install.sh`) и валидатор конфига (`validate-config.sh`).
- **plugins/** — TypeScript-плагины, загружаемые через OpenCode plugin API (rtk token-saver, freshness plugin).

## Структура

```
OpenCode/
├── agents/
│   ├── primary/            # Пользовательские оркестраторы
│   └── subagents/          # Специализированные воркеры (делегируются primary)
├── commands/               # Слэш-команды
├── docs/                   # Project-side templates (например, feedback README)
├── plugins/                # OpenCode-плагины (rtk, freshness)
├── scripts/                # Установщик и валидатор конфига
├── skills/                 # Скиллы с инструкциями и references/
├── opencode.example.jsonc  # Базовый конфиг (Cloud.ru)
└── README.md
```

Primary-агенты взаимодействуют с пользователем напрямую и делегируют подзадачи subagent-ам. Subagent-ы не вызываются пользователем напрямую — они выполняют конкретные задачи по запросу primary-агентов.

## Зависимость от rtk

Бандл опционально использует [rtk](https://github.com/rtk-ai/rtk) — CLI-обёртку, переписывающую стандартные команды (git, ls, grep, ...) в эквиваленты с пониженным расходом токенов. Поведение:

- Плагин `plugins/rtk.ts` подключается автоматически при наличии `rtk` в `PATH`; если бинарь не найден, плагин тихо отключается и все агенты продолжают работать на стандартных командах.
- В permission-паттернах всех агентов команды `git *` продублированы: `git *` (нативный) и `rtk git *` (оптимизированный). Без rtk спокойно работает на plain git, просто без экономии токенов.
- Review-агенты с узкими bash-allowlist'ами (`git status/diff/show/log/rev-parse/merge-base`) получают оба варианта автоматически, чтобы доменное ревью не упиралось в отсутствие rtk.

Если экономия токенов важна — поставьте rtk до первого запуска OpenCode:

```bash
brew install rtk   # или иной способ из официального README rtk
```

Без rtk всё функционирует штатно.

## Агенты

### Primary

| Агент | Назначение |
|-------|-----------|
| `General` | Direct-action primary-агент для простых инженерных, документационных и operational-задач |
| `dev-orchestrator` | Тонкий оркестратор Dev-suite: gates, kanban, делегирование, выбор ревьюеров, агрегация результатов |
| `fast-spec-analyst` | Лёгкий requirements-аналитик для простых изменений и быстрых handoff-ready спецификаций |
| `full-spec-analyst` | Комплексное обнаружение и написание спецификаций для сложных фич |
| `project-analyst` | Свободный анализ проекта, Q&A, диагностика code smells и pre-discovery исследования |
| `tester` | Оркестрация написания pytest-тестов, роста покрытия и многошаговой проверки качества |

### Subagents

| Агент | Назначение |
|-------|-----------|
| `committer` | Создание безопасного git-коммита с conventional message и pre-commit хуками |
| `contract-impact-auditor` | Аудит влияния фичи на API, события, схемы, очереди, persistence, контракты |
| `design-planner` | Планирование дизайна, trade-off анализ, execution sequencing |
| `edge-case-harvester` | Систематический перебор edge-кейсов, негативных сценариев, конфликтных состояний |
| `feature-triager` | Фрейминг задач, уточнение скоупа и требований, kanban-first триаж |
| `graph-impact-analyst` | Анализ влияния изменений через read/glob/grep: зависимости, радиус, контракты |
| `implementer` | Ограниченные изменения кода и написание тестов на границах этапов |
| `non-functional-prober` | Анализ нефункциональных требований: производительность, надёжность, безопасность, observability |
| `project-init-runner` | Least-privilege раннер для `/init`: создаёт и обновляет project-root `AGENTS.md`, freshness metadata и feedback pointers |
| `repo-scout` | Разведка репозитория, реконструкция поведения системы, поиск точек влияния |
| `reviewer-against-plan` | Ревью соответствия реализации плану: дрейф скоупа, acceptance criteria |
| `reviewer-complexity` | Ревью алгоритмической сложности и статических hotspots |
| `reviewer-contracts` | Ревью совместимости контрактов: API, схемы, события, конфиги |
| `reviewer-deep` | Глубинное ревью: архитектура, скрытые связи, долгосрочная согласованность |
| `reviewer-performance` | Ревью производительности: ресурсы, кэширование, конкурентность, N+1 |
| `reviewer-security` | Ревью безопасности: валидация входов, границы доверия, утечки секретов |
| `reviewer-tests` | Ревью качества тестов: регрессия, покрытие, детерминизм, фикстуры |
| `test-planner` | Построение behavior-oriented test plan из одной planning capsule |
| `test-reviewer` | Итоговое ревью тестов против плана, стандартов и фактической верификации |
| `test-writer` | Реализация тестов по утверждённому плану с локальной самопроверкой |
| `traceability-checker` | Проверка полноты и трассируемости спецификаций (цели → сценарии → требования → тесты) |
| `verification-engineer` | Посткоммит-верификация: тесты, линт, типы, сборка, acceptance criteria |

## Команды

| Команда | Назначение |
|---------|-----------|
| `commit` | Создание git-коммита в conventional формате с pre-commit хуками |
| `feedback` | Захват context-aware feedback из текущей сессии в `docs/feedback/feedback_<slug>.md` |
| `init` | Инициализация, обновление и проверка project-root `AGENTS.md` через `project-init-runner` |
| `spec` | Комплексный discovery и подготовка implementation-ready спецификации для сложной задачи |
| `spec-lite` | Лёгкий spec workflow для простых изменений с возможной эскалацией в `/spec` |
| `execute-spec` | Запуск `dev-orchestrator` по явной ссылке на spec с обязательной предварительной валидацией |
| `test` | Запуск `tester` для diff-oriented, targeted или bootstrap-coverage тестового workflow |
| `analyze` | Свободный анализ проекта: вопросы, архитектура, code smells, pre-discovery |

## Скиллы

| Скилл | Назначение |
|-------|-----------|
| `codegraph-impact-analysis` | Анализ радиуса изменений: вызовы, зависимости, тесты |
| `commit-readiness` | Проверка готовности к коммиту: kanban-состояние, stage, скоуп |
| `complexity-review` | Справочник для ручного ревью алгоритмической сложности и оптимизаций |
| `contract-impact-audit` | Аудит влияния фичи на внутренние и внешние контракты |
| `decision-log` | Фиксация инженерных решений, альтернатив и принятых рисков в kanban |
| `delegation-context` | Обеспечение полной передачи контекста при делегировании сабагентам |
| `design-brief` | Формирование дизайн-брифа с анализом trade-off и секвенированием реализации |
| `edge-case-harvest` | Систематический перебор edge-кейсов, негативных сценариев, деградационных режимов |
| `execution-plan` | Планирование реализации с шагами, зависимостями и рисками |
| `feature-interrogation` | Структурированное уточнение требований, скрытых ожиданий и acceptance criteria |
| `find-docs` | Получение авторитетной актуальной документации по внешним технологиям (библиотеки, API, CLI, cloud); опционально использует Context7 |
| `git-commit` | Workflow для генерации conventional commit messages (включая ticketless-режим для нетикетных работ) |
| `implementation` | Процедурный плейбук для ограниченной реализации изменений |
| `kanban-discipline` | Дисциплина работы с kanban: обновление статусов, связей, решений |
| `non-functional-probe` | Анализ нефункциональных требований: производительность, надёжность, безопасность |
| `orchestration` | Процедурный плейбук workflow-контроля для DevOrchestrator: stages, handoff, агрегация |
| `project-init` | Генерация и обновление project-root `AGENTS.md` с managed sections, boundaries и feedback memory pointer |
| `project-rules-check` | Read-only проверка документированных команд, freshness metadata и stale references в `AGENTS.md` |
| `repo-reconnaissance` | Разведка репозитория: поиск модулей, паттернов, точек влияния |
| `replan-on-surprise` | Остановка реализации при неожиданном расширении скоупа, возврат к планированию |
| `review` | Общий read-only протокол ревью для доменных ревьюеров |
| `review-against-plan` | Ревью изменений против оригинального плана: дрейф, пропуски, скоуп |
| `spec-discovery` | Обнаружение и первичный анализ пространства спецификаций |
| `spec-synthesis` | Синтез итоговой спецификации из артефактов: сценарии, требования, acceptance criteria |
| `task-workspace` | Инициализация и поддержка workspace с областью задачи для фичи или запроса на изменение |
| `testing-python` | Стандарты написания и ревью pytest-тестов для Python-сервисов: unit, integration, architecture, gRPC/protobuf |
| `traceability-check` | Проверка полноты и трассируемости спецификаций |
| `verification` | Процедурный плейбук для plan-check и commit-verification |
| `verification-gate` | Требование явного verification-summary перед ревью |
| `workflow-gates` | Enforcement gates: triage, impact, design, implement, commit, verify, review |

## Как пользоваться `tester`

`tester` — это primary-агент для Python-проектов, который сам собирает baseline, coverage, разбивает работу на капсулы, делегирует планирование и написание тестов сабагентам и завершает прогон итоговым review.

### Когда использовать

- Нужно покрыть тестами **текущую ветку** или последние изменения.
- Нужно покрыть **конкретный файл, модуль или подсистему**.
- Нужно **поднять покрытие** в проекте или в большом куске проекта.
- Нужно сделать не просто «добавь тест», а полный цикл: baseline → plan → implementation → review → verification.

### Типовые запросы

Примеры промптов для `tester`:

- `покрой тестами изменения в текущей ветке`
- `напиши pytest-тесты для project/services/user_service.py`
- `подними покрытие тестами до 50% в project/services/`
- `добавь тесты для нового модуля и проверь, что baseline не красный`
- `проверь тесты в tests/project/services/ на antipatterns и исправь найденное`

### Что делает агент

`tester` работает в одном из трёх режимов:

- `diff-oriented` — покрытие изменений в текущей ветке;
- `targeted` — работа по конкретному модулю, пакету или подсистеме;
- `bootstrap-coverage` — рост покрытия с нуля или до заданной цели.

Все промежуточные артефакты складываются в `docs/agent-testing/<run-id>/`:

- `goal.md` — цель запуска;
- `baseline.yaml` — состояние тестов до правок;
- `coverage-summary.yaml` — нормализованная сводка покрытия;
- `capsules/` — planning capsules;
- `plans/` — планы тестов;
- `writer-reports/` — отчёты реализации;
- `review-report.md` — итоговое ревью;
- `final-report.md` — финальный отчёт по запуску.

### Рекомендации по моделям

Строгой привязки к конкретным моделям нет, но для стабильной работы рекомендуется:

- **для `tester` и `test-reviewer`** — сильная reasoning-модель;
- **для `test-planner`** — модель, уверенно работающая с большим контекстом, и неслабым reasoning;
- **для `test-writer`** — можно использовать более быструю модель, если финальный reviewer и verification остаются обязательными.

Практическое правило: если агент начинает терять инварианты, путать артефакты или пропускать self-audit, повышайте класс модели хотя бы для orchestration и review.

#### Как задать модель агенту

Модели для агентов задаются централизованно в `~/.config/opencode/opencode.json`, а **не** в md-файлах агентов. Это позволяет менять модель в одном месте без правки самих агентов. Формат: `provider/model-id`.

```json
{
  "agent": {
    "tester": {
      "model": "cloudru/moonshotai/Kimi-K2.6"
    },
    "test-planner": {
      "model": "cloudru/moonshotai/Kimi-K2.6"
    },
    "test-writer": {
      "model": "cloudru/deepseek-ai/DeepSeek-V4-Pro"
    },
    "test-reviewer": {
      "model": "cloudru/moonshotai/Kimi-K2.6"
    }
  }
}
```

> Если модель не задана, primary-агент использует выбранную в текущем контексте модель, а subagent — модель вызвавшего его primary-агента.
>
> Подробнее: [OpenCode docs — Agents → Model](https://opencode.ai/docs/agents/#model).

### Что входит в тестовый bundle

Для `tester` нужны все связанные артефакты:

- `agents/primary/tester.md`
- `agents/subagents/test-planner.md`
- `agents/subagents/test-writer.md`
- `agents/subagents/test-reviewer.md`
- `skills/testing-python/`

Не копируйте только один файл `tester.md` без сабагентов и скилла: он опирается на них напрямую.

## Как пользоваться `dev-orchestrator`

`dev-orchestrator` — primary-агент для управления полным инженерным циклом: triage → impact → design → implement → commit → verify → review. Контролирует kanban-состояние, делегирует специализированным subagent-ам, выбирает tier ревью и агрегирует результаты.

### Когда использовать

- Нужен **полный цикл** разработки фичи от уточнения требований до верификации и ревью.
- Нужно **контролировать процесс** без ручного переключения между воркерами.
- Нужен **invariant `implement → commit → verify/review`** для каждого изменённого worktree.

### Что входит в Dev-orchestrator bundle

Для `dev-orchestrator` нужны все связанные артефакты:

Агенты:

- `agents/primary/dev-orchestrator.md`
- `agents/subagents/repo-scout.md` (reconnaissance)
- `agents/subagents/feature-triager.md` (triage)
- `agents/subagents/design-planner.md` (design + execution)
- `agents/subagents/contract-impact-auditor.md` (contract analysis)
- `agents/subagents/non-functional-prober.md` (NFR)
- `agents/subagents/traceability-checker.md` (completeness)
- `agents/subagents/graph-impact-analyst.md` (impact radius)
- `agents/subagents/implementer.md`
- `agents/subagents/committer.md`
- `agents/subagents/verification-engineer.md`
- `agents/subagents/reviewer-against-plan.md`
- `agents/subagents/reviewer-security.md`
- `agents/subagents/reviewer-deep.md`
- `agents/subagents/reviewer-contracts.md`
- `agents/subagents/reviewer-tests.md`
- `agents/subagents/reviewer-performance.md`
- `agents/subagents/reviewer-complexity.md`

Скиллы:

- `skills/orchestration/`
- `skills/workflow-gates/`
- `skills/kanban-discipline/`
- `skills/decision-log/`
- `skills/commit-readiness/`
- `skills/codegraph-impact-analysis/`
- `skills/design-brief/`
- `skills/execution-plan/`
- `skills/replan-on-surprise/`
- `skills/implementation/`
- `skills/verification/`
- `skills/verification-gate/`
- `skills/review/`
- `skills/review-against-plan/`
- `skills/complexity-review/`
- `skills/contract-impact-audit/` (для reviewer-contracts)
- `skills/non-functional-probe/` (для reviewer-performance)
- `skills/repo-reconnaissance/` (для repo-scout)
- `skills/feature-interrogation/` (для feature-triager)
- `skills/edge-case-harvest/`
- `skills/traceability-check/`
- `skills/git-commit/`
- `skills/delegation-context/`

Не копируйте только один файл `dev-orchestrator.md` без сабагентов и скиллов: он опирается на них напрямую и делегирует им работу на каждом этапе.

## Как пользоваться `/init`

`/init` — slash-команда для bootstrap и сопровождения project-root `AGENTS.md`. Она вызывает `project-init-runner`, который анализирует репозиторий, собирает managed sections, пишет freshness metadata и может учитывать feedback memory при update.

### Когда использовать

- В проекте ещё нет `AGENTS.md`, и нужен стартовый файл с командами, архитектурой и boundary-правилами.
- В проекте уже есть `AGENTS.md`, но его нужно актуализировать после изменений.
- Нужно проверить актуальность `AGENTS.md` без записи (`/init --check`).
- Нужно посмотреть план изменений без записи (`/init --dry-run`).

### Режимы и алиасы

- `/init` — автоматически выбирает `create` или `update`.
- `/init --check` — read-only verification.
- `/init --dry-run` — показывает план изменений без записи.
- `/init --mode create` — принудительно создаёт новый `AGENTS.md`.
- `/init --mode update` — принудительно обновляет существующий `AGENTS.md`.

### Что входит в `/init` bundle

Для `/init` нужны все связанные артефакты:

- `commands/init.md`
- `agents/subagents/project-init-runner.md`
- `skills/project-init/`
- `skills/project-rules-check/`

Не копируйте только `init.md` без раннера и скиллов: команда зависит от `project-init-runner`, а раннер — от `project-init` и `project-rules-check`.

### Что создаёт `/init`

- `<project-root>/AGENTS.md`
- `<project-root>/.opencode/agents-freshness.json`

`AGENTS.md` пишется только в корне целевого проекта. Глобальный `~/.config/opencode/` root для `/init` запрещён.

## Feedback memory и `/feedback`

`/feedback` — slash-команда в том же контексте. Она не запускает новый subagent, а использует текущую сессию, чтобы вывести конкретное `Why` / `How to apply` из только что выполненной работы и сохранить это как локальную запись feedback проекта.

### Когда использовать

- Агент предложил неверный command, boundary, architecture-совет или style-паттерн.
- Нужно сохранить project-specific correction для будущих `/init --mode update` запусков.
- Важно, чтобы feedback был выведен из текущего контекста, а не из голой короткой фразы пользователя.

### Что делает `/feedback`

1. Использует текущую сессию и `$ARGUMENTS` для вывода конкретного feedback.
2. Строит slug вида `feedback_<category>-<short-description>.md` с collision-safe суффиксом.
3. Пишет `docs/feedback/feedback_<slug>.md`, если у текущего агента есть узкий write/edit доступ.
4. Если записи нет — показывает полный draft в чате и предлагает сохранить его вручную.

### Что входит в `/feedback` bundle

- `commands/feedback.md`
- `docs/feedback/README.md`

Схема feedback memory относится к **проекту**, а не к `~/.config/opencode/`. После копирования OpenCode bundle положите schema-файл в целевой проект:

```bash
mkdir -p <project-root>/docs/feedback
cp OpenCode/docs/feedback/README.md <project-root>/docs/feedback/README.md
```

Если хотите, чтобы `/feedback` писал файлы напрямую в опубликованных primary-агентах, используйте обновлённые версии `agents/primary/dev-orchestrator.md`, `agents/primary/full-spec-analyst.md` и `agents/primary/tester.md` из этого репозитория: в них уже есть узкие разрешения на `docs/feedback/feedback_*.md`.

## Conventions

- **Агенты**: `agents/primary/<name>.md` — пользовательские оркестраторы; `agents/subagents/<name>.md` — специализированные воркеры.
- **Команды**: `commands/<name>.md` — слэш-команды.
- **Скиллы**: `skills/<name>/` — содержит `SKILL.md` и опционально `references/` с дополнительными конфигами и шаблонами и `scripts/` с дополнительными утилитами, которые могут быть вызваны из `SKILL.md`.

## Установка

### Установка через per-item symlink-ы (рекомендуется)

Скрипт-установщик создаёт управляемые симлинки на уровне отдельных файлов агентов, команд и скиллов, а также отдельных файлов в `plugins/`, внутри `~/.config/opencode/`. Корневые директории `agents/`, `commands/`, `skills/` и `plugins/` остаются обычными директориями, поэтому рядом можно хранить свои файлы и сторонние расширения. Состояние установки хранится в `~/.config/opencode/.opencode-handoff-state.json`.

```bash
# Просмотреть, что будет сделано
./scripts/install.sh --dry-run

# Установить или обновить симлинки и конфиг
./scripts/install.sh

# Удалить управляемые симлинки
./scripts/install.sh --uninstall
```

Для тестирования или изолированной установки можно указать кастомную директорию:

```bash
./scripts/install.sh --target-dir /tmp/opencode-config
```

### Standalone-валидация конфига

`install.sh` уже вызывает валидатор автоматически. Отдельный запуск нужен только если хочешь проверить конфиг без переустановки симлинков:

```bash
# Если конфига нет — создаст из opencode.example.jsonc
# Если конфиг есть — проверит обязательные поля и отчитается об ошибках/предупреждениях
./scripts/validate-config.sh

# Или проверить кастомную директорию
./scripts/validate-config.sh --target-dir /tmp/opencode-config
```

## Конфигурация провайдеров

Базовый конфиг с провайдером Cloud.ru Foundation Models, привязкой моделей к агентам и `{env:CLOUDRU_API_KEY}` находится в [`opencode.example.jsonc`](opencode.example.jsonc).

> [!tip]
> Официальная документация по подключению провайдеров: <https://opencode.ai/docs/providers/#custom-provider>

### Быстрый старт

1. Установите бандл, создайте или провалидируйте конфиг:
   ```bash
   ./scripts/install.sh
   ```

2. Задайте API-ключ в shell-профиле:
   ```bash
   # Для zsh:
   echo 'export CLOUDRU_API_KEY=your-key-here' >> ~/.zshrc
   source ~/.zshrc

   # Для bash:
   echo 'export CLOUDRU_API_KEY=your-key-here' >> ~/.bashrc
   source ~/.bashrc
   ```

3. Откройте любой проект и запустите `opencode`.

Выбор модели зависит от задач: быстрые модели для рутинных операций (коммиты, простые ревью), более мощные — для глубокого анализа и генерации сложных спецификаций.

> Базовый конфиг включает только Cloud.ru провайдер. Другие провайдеры из персонального конфига не входят в контракт передачи.

## Git commit workflow

Воркфлоу для автоматизированного коммита реализован через скилл `git-commit` и сабагент `committer`. Подробнее: [`skills/git-commit/SKILL.md`](skills/git-commit/SKILL.md).

По умолчанию `/commit` требует EVODP-тикет в имени ветки и формирует сообщение формата `<type>(EVODP-1234): <description>`. Для нетикетной работы (разработка самого фреймворка, chore-ветки, разовые правки) включите ticketless-режим одним из способов:

- Передайте `/commit --no-ticket <описание>`
- Или упомяните в `$ARGUMENTS` слова `ticketless`, `no ticket`, или `без тикета` — флаг будет распознан автоматически

В ticketless-режиме сообщение выходит без scope: `<type>: <description>`. Все остальные policy (branch safety, pre-commit hooks, English-only, 20-word limit, secret scanning) сохраняются.

## Тюнинг параметров моделей Foundation Models

TODO (<https://wiki.cloud.ru/x/-e5PJg>)

## Подключение MCP (опционально)

> [!note]
> MCP не требуется для работы бандла. При отсутствии kanban MCP скилл `kanban-discipline` автоматически переключается на file-based логирование в `decision-log.md`.

Для работы с kanban (используется в скиллах `kanban-discipline` и агентах `feature-triager`, `design-planner`, `full-spec-analyst`):

```bash
curl -fsSL https://raw.githubusercontent.com/multidimensionalcats/kanban-mcp/main/install.sh | bash
```

Добавить в существующий `~/.config/opencode/opencode.jsonc`:

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
