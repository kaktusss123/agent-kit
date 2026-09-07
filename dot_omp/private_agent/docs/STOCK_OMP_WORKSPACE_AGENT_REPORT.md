# Отчёт: фреймворк Task Workspace на стоковом OMP — workspace_agent + детерминистические фиксы

Дата: 2026-09-05. Репо: `~/projects/dotfiles` @ `chore/task-workspace-runtime` (изменения в рабочем дереве, не закоммичены). Спека: «Implementation spec: stock OMP task workspaces and rooted RepoOwner».

## Цель и результат

Убрана зависимость framework от патчей ядра oh-my-pi. Установленный OMP остаётся стоковым; multi-repo `/dev` запускает RepoOwner'ов через новый extension-тул `workspace_agent`, реально rooted в managed task worktree. Ядерные коммиты (`backup/task-workspace-core` в `~/projects/devtools/oh-my-pi`) для фреймворка больше не требуются.

## 1. SDK bridge — новый extension `dot_omp/private_agent/extensions/workspace-agent.ts`

- Тул `workspace_agent(workspace, task, timeout_ms?)`: спавнит RepoOwner — полноценную агентную сессию, rooted в managed worktree (`cwd` + `SessionManager.inMemory(workspace)`), с приватным `AgentRegistry` на invocation, без персистентной сессии.
- Только публичный SDK через `pi.pi` (`createAgentSession`, `SessionManager.inMemory`, `AgentRegistry`); без runtime-импортов приватных путей и без npm-зависимости. Capability check до dispatch: отсутствует капабилити → `{status: "unsupported", dispatched: false}`.
- Валидация workspace до dispatch: существует → linked worktree → под `TASK_ROOT` → canonical repo root == workspace; root invariant после создания сессии (`session.sessionManager.getCwd() == workspace`). Нарушение — отказ без отправки assignment.
- Модель: пиннится к активной модели Main через `ctx` событий `turn_start`/`agent_start`; нет модели — отказ до dispatch, молчаливый выбор по умолчанию исключён.
- Проектные инструкции цели передаются явно через `contextFiles` (AGENTS/CLAUDE/GEMINI/SYSTEM в корне worktree; ошибка чтения существующего файла → отказ до dispatch). Передача `contextFiles` подавляет авто-discovery — контекст репо-оркестратора не протекает.
- У child удаляется ровно один тул — `workspace_agent` (await `setActiveToolsByName` до `session_start`); `task`, `checkpoint_commit` и прочие остаются. Extension runner child'а инициализируется (без этого `tool_call`-хуки мертвы — mutation guard не работал бы) и эмитится `session_start`.
- Structured output: `outputSchema` (envelope `{status: done|partial|blocked, summary, verification[], gaps[]}`), `outputSchemaMode: "strict"`, `requireYieldTool: true`. Захват через `session.subscribe` на `tool_execution_end` (`toolName === "yield"`, `result.details.status === "success"`, не incremental). Финальное сообщение без валидного yield успехом не считается.
- Settlement повторяет семантику стокового task-драйвера: yield с pending async work — пауза, а не завершение; `settleAsyncWork()` → инвалидация yield → ladder напоминаний (до 3, финальный с named `toolChoice`); терминал = валидный yield при `!hasPendingAsyncWork()`.
- Deadline (default 600 s, параметр `timeout_ms`) + родительский abort → `session.abort()`, `dispose()` в `finally`.
- Fallback-граница: до dispatch — `unsupported`/`blocked` + `dispatched=false` (Main может деградировать на stock `task` + absolute paths); после dispatch автоповтора нет — `partial`/`blocked` + `child_may_have_mutated_repo=true`, repair = новый invocation, сначала инспектирующий существующее состояние.
- Параллельность: новых batch API нет; независимые вызовы `workspace_agent` параллельны, у каждого свой SessionManager/registry/workspace/lifecycle.

## 2. Детерминистические фиксы рантайма (`task-workspace.ts`)

- `ensure_task_repo`: один обязательный fetch при отсутствии локальной ветки; ошибка fetch → fail closed (stale refs никогда не материализуют ветку); remote-ветка → **attached tracking branch** (`worktree add --track -b`, не detached HEAD); второй fetch из base selection убран (используются уже обновлённые refs). Ответы несут `branchSource` (`local|remote|base`) и `upstream` (`reused`/`attached` — без network-обязательств).
- `task_status`: workspace идентифицируется путём + opaque `key` (basename каталога); `branch` уровня workspace удалён как lossy; ветки — только per-repo/lane.
- Deferred hooks: evidence обязана нести `staged_tree` — SHA staged tree из ответа `commit_failed` (final state после hook-induced restage); mismatch дерева → `deferred_hook_rejected`; `manual_checks` принимают только machine-readable pass (`pass|passed|ok|success|successful|true|yes`, case-insensitive).
- Mutation guard: `parseGitInvocations` классифицирует **каждый** `git`-вызов в compound-команде (`git status && git commit` блокируется; `git log | grep` — нет); `--no-verify` привязан к мутирующему вызову, не к строке; `classifyPath` не бросает на несуществующих путях (создание новых файлов в primary не валит guard).
- Worktree hint: блокировка primary перечисляет все managed worktrees **того же** репо (один → одна, несколько → список до 8), чужие репо не подсовываются, путь не придумывается при отсутствии кандидатов.
- §21: non-injective flattening branch→каталог задокументирован как residual limitation (header extension + док); манифеста/миграции нет.

## 3. Инструкции и документация

- `dot_omp/private_agent/prompts/dev.md`: multi-repo flow — оркестратор спавнит владельцев через `workspace_agent`; вложенные хелперы — stock `task`; fallback на absolute-path только при pre-dispatch `unsupported`; после dispatch автоповтора нет.
- `dot_omp/private_agent/skills/git-task/SKILL.md`: identity по workspace `key` (ветки — per-repo); `/dev multi repo` переписан под `workspace_agent` + fallback.
- Новый `dot_omp/private_agent/docs/TASK_WORKSPACE.md`: архитектура (workspace_agent ≠ task), deterministic runtime tools, fallback и честная гарантия совместимости, известные ограничения.
- `docs/FIELD_RUN_EVODP-11781_TASK_WORKSPACE.md`: врезка «архитектура на 2026-09-05», упоминания `task(workspace=…)` помечены историческими.
- Удалён мёртвый `scripts/runtime-smoke.ts` (импортировал архивированный `extensions/docs/history/task-runtime`).

## Проверки (все выполнены на этой машине)

| Набор | Результат | Доказывает |
|---|---|---|
| `tests/task-workspace/verify-scenarios.ts` | 34 PASS / 0 FAIL | lifecycle (created/reused/remote-only), fetch fail-closed (без worktree из stale refs), attached branch + upstream, key-identity, guard basics, dirty source, commit safety; прогон и против задеплоенной копии — 34/0 |
| `tests/task-workspace/verify-scenarios-2.ts` | 31 PASS / 0 FAIL | compound-guard (`&&`/`;`/pipe/кавычки), `--no-verify` (везде запрещён, в кавычках — нет), same-repo hints (multi/single/none), lanes внутри canonical workspace, deferred evidence: tree-binding, stale tree reject, non-pass reject, machine-readable pass commit |
| `tests/task-workspace/verify-bridge.ts` | 15 PASS / 0 FAIL | реальный стоковый SDK + скриптованная mock-модель (без провайдера): capability fail-closed, валидация workspace, rooted write относительным путём (файл в worktree, не в source), доставку project context цели без утечки чужого, исполнение project-local extension child'а, `session_start` через инициализированный runner, удаление `workspace_agent` при живом `task`, root invariant, no-yield → blocked + mutation warning, deadline → partial c abort/dispose |
| Typecheck | clean | оба extension против типов стокового SDK 18.1.9 (`extensions/tsconfig.json`, extends checkout base config) |
| Deploy parity | `cmp` OK | `chezmoi apply` → байт-в-байт совпадение repo ↔ `~/.omp/agent/extensions/` |

Запуск: `bash tests/task-workspace/build-fixture.sh && bun run tests/task-workspace/verify-scenarios.ts` (затем `-2`, `verify-bridge`). Фикстура одноразовая; повторный прогон без rebuild отсеивается sentinel-проверкой.

## Model-backed smoke — BLOCKED (внешний фактор)

`tests/task-workspace/smoke-model-backed.ts` готов (opt-in, `TW_MODEL_SMOKE=1`): создаёт disposable source repo + managed worktree, пиннит конкретную модель (`TW_SMOKE_MODEL`, default `zai/glm-5.3-flash`) и требует валидный structured yield. Реальный прогон упирается в credentials инсталляции: прямой вызов провайдера даёт **401 «User not found»** (воспроизведено изолированно минимальной сессией; `hasConfiguredAuth` = true, ключ невалиден). Инфраструктура смоука работает до границы провайдера — dispatch, сессия, extension loading, settlement и классификация покрыты bridge-suite; не подтверждён только финальный rooted write **реальной** моделью.

Перезапуск после починки ключа:
```bash
TW_MODEL_SMOKE=1 TW_SMOKE_MODEL="openrouter/<working-model-id>" \
  bun run tests/task-workspace/smoke-model-backed.ts
```

## Известные ограничения

- RepoOwner-сессии ephemerality (in-memory) — by design; долговечное состояние в git.
- Non-injective flattening branch → имя каталога workspace; коллизии решаются вручную, манифеста нет.
- Явно передаются только root-level instruction files; более глубокая discovery внутри worktree работает как стоковая для собственного cwd сессии.
- Model-backed прогон на реальной модели — см. blocked выше; nested-task/async-сценарии на реальной модели не гонялись (механика покрыта bridge-suite и семантикой стокового драйвера).
- Новые тулы видят только новые OMP-сессии (текущая сессия загрузила extension до изменений).

## Изменённые файлы

- `M` `.chezmoiignore` (+`tests`, +`.omp/agent/extensions/tsconfig.json`)
- `M` `dot_omp/private_agent/extensions/task-workspace.ts` (+схемы на typebox, fetch-семантика, key-identity, deferred tree-binding, compound guard, hints, upstream/branchSource)
- `M` `dot_omp/private_agent/prompts/dev.md`, `dot_omp/private_agent/skills/git-task/SKILL.md`
- `M` `dot_omp/private_agent/docs/FIELD_RUN_EVODP-11781_TASK_WORKSPACE.md` (врезка)
- `D` `dot_omp/private_agent/scripts/runtime-smoke.ts`
- `A` `dot_omp/private_agent/extensions/workspace-agent.ts`, `dot_omp/private_agent/extensions/tsconfig.json`
- `A` `dot_omp/private_agent/docs/TASK_WORKSPACE.md`
- `A` `tests/task-workspace/` (build-fixture.sh, verify-scenarios.ts, verify-scenarios-2.ts, verify-bridge.ts, smoke-model-backed.ts)

## Next actions

1. Коммит/пуш `dotfiles` — по явной команде.
2. Починка openrouter-ключа инсталляции → прогон model-backed smoke (команда выше).
3. Опционально: удалить `backup/task-workspace-core` в `~/projects/devtools/oh-my-pi`, если upstream-PR не планируется.
