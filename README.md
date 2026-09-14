# agent-kit

Мой личный agent framework, ориентированный на **Pi** (pi-coding-agent).
Один обычный git-репозиторий: canonical skills, deterministic Pi extensions,
инсталлер с честной моделью владения ссылками.

Это не multi-harness distribution. OMP и OpenCode были промежуточными
этапами и больше не являются целями этого репозитория: их assets удалены
из active architecture, а git history сохраняет их прошлое. Port под другой
harness — это отдельный downstream-проект, который адаптирует canonical
agent-kit под себя, а не уровень абстракции здесь.

## Структура

```
skills/<name>/           canonical skill packages:
                           SKILL.md      — semantic policy и judgment
                           references/   — operating contracts (могут быть
                                           Pi-specific, это нормально)
                           scripts/      — только если skill'у реально нужны
                                           свои скрипты
extensions/<name>/       Pi extensions: deterministic runtime mechanics
prompts/                 тонкие Pi prompt templates — workflow entrypoints
                           /spec и /dev; связывают существующие skills,
                           а не дублируют их policy
rules/AGENTS.md          канонический глобальный instructions-файл,
                           единый источник ~/.pi/agent/AGENTS.md; присутствует,
                           только когда файл существует
bin/agent-kit            инсталлер (install / uninstall / status)
tests/                   verification:
                           installer/ — ownership-семантика инсталлера
                           layout/    — бывшая multi-harness архитектура
                                        не возвращается
                           skills/    — валидация skill-пакетов и промптов
```

Категория `scripts/` появляется в корне только тогда, когда в ней есть
реальный контент; пустые директории ради схемы не создаются.

## Workflow entrypoints

`/spec` и `/dev` — тонкие Pi prompt templates (`~/.pi/agent/prompts/`):

- **`/spec`** — Main владеет discovery: разговор с пользователем, product
  и design решения, синтез evidence, canonical `SPEC.md`. Repository
  analysis — по состоянию managed task worktree (explicit paths или
  bounded research subagents с `cwd=<worktree>`), не dirty source
  checkout. cwd Main-сессии не меняется.
- **`/dev`** — Main — task controller: intent, решения, оркестрация,
  review, integration. Мутация репозиториев выполняется RepoOwner'ами
  (`subagent` op `spawn` с `workspace=<worktree>`, по одному на writable
  repository). Owner'ы реализуют и верифицируют внутри своих worktrees;
  Main ревьюит результат и чинит через fresh owner.

Промпты задают mode и связывают существующие capabilities (`skill://git-task`,
`skill://implementation`, …); вся policy живет в skills/references.

## Semantic policy vs deterministic mechanics

Разделение сохранено, но это разделение не про portability:

- **SKILL.md** — когда skill применяется, semantic policy, decision rules,
  требования к результату. То, что решает модель.
- **references/** — конкретные operating contracts, нужные для исполнения:
  имена Pi-инструментов, аргументы, meaningful statuses, lifecycle
  semantics, гарантии extension-кода. Модель не обязана знать реализацию —
  только observable contract: какая гарантия существует и на что можно
  положиться.

Skill может быть Pi-specific, может требовать конкретную Pi extension и
может не иметь смысла без deterministic capability. Правильный вопрос —
«хорошо ли этот skill работает как часть agent-kit?», а не «можно ли
скопировать его в произвольный harness?».

Пилоты этого разделения:

- `skills/git-task/` — `SKILL.md` (task policy, identity, base selection,
  owners, review/repair) + `references/task-workspace.md` (контракт
  `task_status` / `ensure_task_repo` / `remove_task_lane` и mutation guard)
  + `references/repo-owners.md` (контракт workspace-спавна `subagent`, `needs_input`,
  terminal lifecycle, repair).
- `skills/git-commit/` — `SKILL.md` (checkpoint judgment, branch/ticket/
  message policy, secrets) + `references/checkpoint.md` (контракт
  `checkpoint_commit`: inputs, statuses, deferred-hook evidence).

Где начинается конкретная Pi-механика, SKILL.md требует reference как
mandatory: например, перед работой с task workspace — прочитать
`references/task-workspace.md`.

## Extensions

`extensions/` — обычный Pi extension tree (глобальные расширения Pi живут
в `~/.pi/agent/extensions/`):

- **task-workspace** — managed task worktrees: `task_status`,
  `ensure_task_repo`, `remove_task_lane`, `checkpoint_commit` и mutation
  guard (PATH-shim для git в bash-сессиях: policy на реальном argv + cwd,
  без парсинга shell). Ядро (`flows.ts`, `git.ts`, `guard.ts`, `types.ts`)
  host-independent и тестируется без Pi (`core-isolation.test.ts`); второй
  real consumer у него отсутствует, поэтому library-уровень не выделяется.
- **subagents** — единый subagent runtime; workspace-режим того же `subagent`
  (RepoOwner-протокол: readiness handshake, deadline, terminal envelope,
  settled-state verification).
- **ask** — структурные вопросы модели к пользователю/владельцу сессии.
- **todo**, **continue-shortcut**, **agent-events**, **web-search**,
  **perf-stats**, **footer** — task list, shortcut, events/статусы, поиск,
  производительность, кастомный footer.

`footer.ts` раньше назывался `omp-footer.ts`; имя отражало происхождение
визуального дизайна, а не назначение — расширение переименовано.

## Install

```sh
./bin/agent-kit install      # из checkout'а; после этого доступно как agent-kit
agent-kit install            # reconcile
agent-kit status
agent-kit uninstall
```

Инсталлер обслуживает ровно один runtime — Pi. Аргументов вида
`install <runtime>`, autodetection бинарей и runtime marker-файлов больше
нет. Раскладка репозитория и есть desired state:

```
skills/*     -> ~/.pi/agent/skills/*
extensions/* -> ~/.pi/agent/extensions/*
prompts/*    -> ~/.pi/agent/prompts/*   (если категория существует)
rules/AGENTS.md -> ~/.pi/agent/AGENTS.md   (если файл существует)
```

Установка — это symlinks из `~/.pi/agent` в этот checkout, никогда
копирование. Override корня: `PI_AGENT_DIR` (по умолчанию `~/.pi/agent`).
- Каждый `install` заодно ставит команду
  `~/.local/bin/agent-kit -> <этот checkout>/bin/agent-kit`. Повторный
  `install` из другого checkout'а/worktree переносит управляемые ссылки и
  команду на него (предыдущий checkout не модифицируется) — так удобно
  переключаться между primary checkout'ом и task worktree.
- Отдельных `--prune`/`--force` нет: item, удалённый из репозитория,
  убирается при следующем `install`.

### Ownership model

Состояние — `~/.local/state/agent-kit/links.tsv` (или `$XDG_STATE_HOME`),
одна строка на ссылку: `<dest-rel>\t<source>`. Инварианты:

1. Управляется только ownership set — то, что записано в state. Содержимое
   `~/.pi/agent` никогда не сканируется «на предмет всего своего».
2. Запись в state не даёт права удалить путь. Ссылка снимается/переносится
   только если её текущая цель — в точности та, которую agent-kit записал
   последним `install`. Ссылка, перенаправленная вручную, не трогается:
   ownership освобождается, место сообщается как conflict.
3. Item удалён из репозитория: если ссылка всё ещё наша — снимается; если
   цель уже отсутствует — чистится state; если цель подменили — не
   трогается.
4. Real files, каталоги и чужие symlinks на желаемом пути — conflict,
   молча не перезаписываются никогда.
5. Corrupt state не может расширить множество допустимых удалений — только
   сузить: каждая запись валидируется (ровно два поля, безопасный
   относительный путь без traversal, абсолютный source), мусор отбрасывается
   с warning'ом.
6. `~/.local/bin/agent-kit` подчиняется тем же правилам через отдельную
   запись (`command.tsv`): чужой real file или symlink не трогается, свой
   launcher переносится при переключении checkout'а. `uninstall` команду не
   снимает.

### Legacy ownership state

Версии agent-kit эпохи нескольких runtime'ов писали state в формате
`<runtime>\t<dest-rel>\t<source>` для pi, omp и opencode. Первый же
`install` или `uninstall` мигрирует его один раз:

- строки pi переходят в текущий формат без потери владения;
- строки omp/opencode убираются под их историческими корнями
  (`~/.omp/agent`, `~/.config/opencode`) с тем же proof: удаляется
  только ссылка, чья цель всё ещё в точности равна записанной; всё
  остальное освобождается без удаления.

Это разовая очистка, а не второй install target: никаких omp/opencode
целей у инсталлера больше нет.

## Разработка из worktree

`agent-kit install` из task worktree переключает управляемые ссылки на этот
worktree; ссылки и state — единственное, что меняется. `status` показывает,
какой checkout сейчас активен. Юнит-тесты расширений запускаются из репо
так: `bun test extensions/<name>`. Разовом linker'ам нужны пакеты pi в
`node_modules` (gitignored):

```sh
mkdir -p node_modules/@earendil-works
ln -s ~/.local/lib/node_modules/@earendil-works/pi-coding-agent/node_modules/typebox node_modules/typebox
ln -s ~/.local/lib/node_modules/@earendil-works/pi-coding-agent node_modules/@earendil-works/pi-coding-agent
ln -s ~/.local/lib/node_modules/@earendil-works/pi-coding-agent/node_modules/@earendil-works/pi-ai node_modules/@earendil-works/pi-ai
ln -s ~/.local/lib/node_modules/@earendil-works/pi-coding-agent/node_modules/@earendil-works/pi-tui node_modules/@earendil-works/pi-tui
```

## Тесты

```sh
tests/installer/run.sh    # 20 сценариев ownership-семантики и legacy-миграции
tests/layout/run.sh       # retired-архитектура (shared/, runtimes/, markers,
                          # runtime-ветки в инсталлере) не возвращается
tests/skills/run.sh       # SKILL.md, references, skill://-цели, stale-язык
bun test extensions       # юнит-тесты расширений
```

Сценарии installer-тестов: fresh install, идемпотентность, переключение
checkout'ов, prune удалённых items (включая подменённую ссылку), нетронутость
чужих ссылок и real-file конфликтов, corrupt/traversal state, пути с
пробелами, launcher bootstrap/switch/ownership, legacy-миграция omp/opencode
state, отказ от runtime-аргументов, линк канонического AGENTS.md в корень
Pi-каталога.

## Переезд со старой схемы

- pi-ссылки переключаются на новый checkout обычным `agent-kit install`
  (relink); расположение `shared/skills/<skill>` больше не используется.
- omp/opencode-ссылки, созданные старым инсталлером, убираются
  автоматически при первом `install`/`uninstall` (см. Legacy ownership
  state). Ссылки, созданные другими инструментами (chezmoi, старые
  install-скрипты), инсталлер не трогает — их снимает вручную владелец.
