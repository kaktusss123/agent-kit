# Changelog

## feat/oc-commands — 2026-07-29

### Что нового

**Primary-агент `project-analyst`.** Отвечает на вопросы по проекту, ищет code smells, делает pre-discovery для будущих спецификаций. Read-only — сам ничего не правит и не пишет спеки. Полезен, чтобы разобраться в незнакомом коде или подготовить почву перед `/spec`.

**Новые команды.** Появилось пять:

- `/spec` — комплексное обнаружение и подготовка implementation-ready спецификации для сложной задачи. Полный цикл: интервью, рекогносцировка, анализ контрактов, edge-кейсы, traceability.
- `/spec-lite` — лёгкий вариант для простых изменений. Сам порекомендует перейти в `/spec`, если задача окажется сложнее.
- `/execute-spec` — запуск `dev-orchestrator` по явной ссылке на готовый спек с обязательной предварительной валидацией.
- `/test` — запуск `tester` для pytest-кампаний: текущая ветка, конкретный модуль, рост покрытия с нуля.
- `/analyze` — свободный анализ проекта: вопросы, архитектура, code smells, pre-discovery.

**Новые скиллы.** `delegation-context`, `git-commit`, `project-init`, `task-workspace`, `verification-gate`, `workflow-gates` — правила передачи контекста в сабагентов, conventional commit, онбординг проектов через `/init`, дисциплина kanban, gates и ревью-проверки. Аналитические: `repo-reconnaissance`, `codegraph-impact-analysis`, `contract-impact-audit`, `non-functional-probe`, `edge-case-harvest`, `feature-interrogation`, `design-brief`, `execution-plan`, `implementation`, `verification`, `review`, `review-against-plan`, `traceability-check`, `complexity-review`, `commit-readiness`, `decision-log`, `replan-on-surprise`, `spec-discovery`, `spec-synthesis`, `orchestration`, `testing-python`. Скилл `find-docs` перенесён в бандл и ставится через `install.sh` — больше не нужно держать локально.

**Subagent-ы для оркестраторов.** `repo-scout`, `feature-triager`, `design-planner`, `edge-case-harvester`, `contract-impact-auditor`, `non-functional-prober`, `traceability-checker`, `project-init-runner`, `verification-engineer`, `graph-impact-analyst`, `committer`, `implementer`, семь доменных ревьюеров (`reviewer-against-plan`, `reviewer-security`, `reviewer-deep`, `reviewer-contracts`, `reviewer-tests`, `reviewer-performance`, `reviewer-complexity`), три тестовых (`test-planner`, `test-writer`, `test-reviewer`). Каждый с узкими правами и под своим скиллом.

**`/commit` без тикета.** Для нетикетной работы (разработка фреймворка, chore-ветки, разовые правки, личные проекты) больше не нужен EVODP-тикет. Включается так:

```
/commit --no-ticket обновить документацию
/commit chore: почистить агенты
/commit без тикета рефакторинг настроек
```

В этом режиме сообщение выходит как `<type>: <description>` без scope. Все остальные policy (pre-commit hooks, проверка секретов, English-only, лимит 20 слов) сохраняются.

**`default_agent: "General"`.** Агент общего назначения теперь стоит по умолчанию. Подскажет, если для задачи нужно использовать более узкоспециализированного агента, или выполнит все сам.

**`post-merge` git hook.** После `git pull` в репо с фреймворком автоматически пересоздаются managed-симлинки в `~/.config/opencode/`. Чтобы включить у себя — `./scripts/enable-hooks.sh`.

**Раздел про rtk в README.** Позволяет серьезно экономить токены. Крайне рекомендую. Плагин опционален, все будет работать и без него.

**Документация для feedback-схемы.** Canonical reference живёт в `skills/project-init/references/feedback-schema.md` (ставится через `install.sh`); inline-шаблон в `commands/feedback.md` — для случая, когда агенту лень лезть в reference.

### Что пофикшено

Привёл в порядок permission'ы агентов: мёртвая категория `write` заменена на `edit` с baseline-deny, физический запрет `.env`/`key`/`secret` в read, скрытие внутренних сабагентов в их frontmatter, единый источник истины для task-allowlist'ов. Удалил дубль permission-блоков из `opencode.json`, чтобы frontmatter markdown-агентов был единственным местом правды. `validate-config.sh` теперь принимает `General` как дефолтного агента (раньше падал на собственном конфиге). Синхронизировал модели в example-конфиге с актуальной линейкой, пополнил bundle-список dev-orchestrator (раньше коллеги получали неполный набор). Почистил `/commit` от захардкоженного `model:` и привёл `/feedback` к project-local схеме. Добавил `--no-ticket` в `git-commit` skill и `/commit` команду. Закрыл мелкие несостыковки и мёртвые правила (например, `kanban: {"*": "allow"}` которого ни один инструмент не матчит).
