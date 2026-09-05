# Полевой прогон Git Task Workspace + Multi-Repo: отчёт по кейсу EVODP-11781

Дата: 2026-09-05. Прогон: реальный инцидент на трёх репозиториях (`trino-lib`, `trino-instance`, `user-plane-api`), две OMP-сессии в истории `user-plane-api` (спек — старт 18:10, дев — старт 19:34), работа до ~02:00.

Статус изменений фреймворка **на момент прогона**: extension `task-workspace.ts`, skill `git-task`, обновлённые `dev.md`/`spec.md`/`RULES.md` были задеплоены (~22:00) **после старта обеих сессий**. Дев-сессия подхватила skill и extension с диска в ходе работы; спек-сессия работала целиком на старых текстах. Исправления по итогам этого отчёта внесены позже (см. врезку ниже) и на момент прогона отсутствовали.

> **Статус после решения архитектора (2026-09-05, дополнено).** Решения по находкам приняты и применены: F1 (URI-guard) и F3 (`worktree list|show`) — исправлены в extension; F4 — уточнён по транскрипту (см. §4) и закрыт embedded-URI-отклонением в общем резолвере write/edit ядра oh-my-pi; F2 — сознательно не sandbox'ится (behavioral-правило в RULES + сообщения guard'а с anti-bypass guidance); Р2 (переспрашивание base) — контракт в `git-task` skill + RULES; Р3 — механизм deferred hook verification в `checkpoint_commit` (с обязательной нормальной попыткой и evidence-гейтами); Р5 — secondary lanes (`ensure_task_repo` с `task`/`slot`); Q1 — усилённое ownership-правило (known multi-repo → owner на каждый writable repo). Детали применения — в итоговом отчёте сессии внедрения.

---

## 1. Условия

Инцидент: после внедрения приватных версий Trino страница списка инстансов падает с `404 DP-ERR-8-005 "Trino version is not available."` на проектах, где есть инстансы на не-ACTIVE версиях. Причина — fail-closed join списка инстансов к ACTIVE-only списку версий бэкенда. Фикс: приватный RPC `ListInstances` в `trino-lib` (items несут собственные version-данные, включая `version_options`), серверная реализация в `trino-instance`, миграция list-flow в `user-plane-api`.

Затронутые репозитории и их состояние на момент работы:
- `~/projects/core/user-plane-api` — primary на `release/v0.14.0` (сессии жили здесь);
- `~/projects/trino/trino-instance`, `~/projects/trino/trino-lib` — соседние чекауты.

## 2. Хронология (из транскриптов)

### Спек-сессия (18:10 → ~22:34)
1. До `/spec`: read-only разбор инцидента по primary-чекаутам и соседним репо (grep/read/bash cat; включая вскрытие dp-trino wheel с artifactory и миграций trino-instance). Task runtime не включался — соответствует §19.
2. По `# Spec workflow`: cross-repo discovery (потребители `ListTrinosResponse` вплоть до public-api), сверка релизных веток.
3. Спецификация записана в **`docs/specs/trino-list-embedded-version.md` в primary checkout** `user-plane-api` (12.5 КБ). Каталог `docs/` присутствует в `.gitignore:167` → файл невидим git'у, в MR попасть не может.
4. `ensure_task_repo` не вызывался; `~/.omp/tasks/.../SPEC.md` спек-фазой не создавался. Проверено: в сессии ноль вызовов `task` и `git add/commit`.

### Дев-сессия (19:34 → ~02:00)
1. Прочитала спеку (`docs/specs/...`) и `skill://git-task`; ветка задачи: `fix/EVODP-11781_list_instances` (тикет из спеки, не выдуман).
2. `ensure_task_repo` × 3 → `~/.omp/tasks/fix_EVODP-11781_list_instances/{trino-lib,trino-instance,user-plane-api}` на одной ветке. Multi-repo workspace материализован.
3. Main реализовала proto-изменение trino-lib сама (edit в worktree, `uv sync`, `make gen-python-trino-protobuf`), разобралась с пиннингом версии либы у консьюмеров.
4. Спавн двух repo-owner'ов: `task(agent=task, workspace=<worktree>)` для trino-instance и user-plane-api. В контексте каждого — зафиксированный контракт: «# Contract (fixed, do not renegotiate): Lib trino-lib already has the proto change in the sibling worktree … generated Python stubs already produced there». Workers меняли только свои репо, гоняли локальные тесты.
5. Main ревьюила диффы workers; написала `integration_check.py` **в workspace** (не в репо); прогнала wire-level integration check из worktree-venv trino-instance (после разбора env-требований: `DB_PG_DSN` и т.п.); локальный pytest user-plane-api (282 passed).
6. Коммиты всех трёх репо в worktrees: `8bf2a07` (lib, feat), `cc5914928` (instance, feat), `72f14a1` (upa, fix). Primary-чекауты на продуктовых фазах нетронуты.
7. По явным командам пользователя:
   - «на либе ветка fix/…, на сервисах ветка hotfix/» → `git branch -m hotfix/EVODP-11781_list_instances` в двух сервисных worktrees;
   - «запуш и создай мр по либе; мры драфт на релизные ветки сервисов; опиши, что блокером является либа; отдельные фикс-ветки от develop, черипикнуть коммиты из хотфиксов, запушить и мры; можешь новые ворктри создать» → push `fix/…` либы, draft-MR instance → release/v0.10, draft-MR upa → release/v0.14.0; дополнительные worktrees `trino-instance-develop`/`user-plane-api-develop` (ветки `fix/…` от develop), cherry-pick, push, вторые MR;
   - vuln-обновления в либе: grpc 1.82.1→1.83.1, pip 26.1.2→26.2.1 (коммит `fix(EVODP-11781): update grpc…`).

## 3. Что сработало

- Multi-repo workspace на одной ветке; workers строго в своих репо с target-контекстом (P1 `task(workspace=…)` подтверждён в живых условиях).
- Защита primary: на всех продуктовых фазах `git status` обоих primary-чекаутов чист; единственная мутация primary за прогон — файл спеки от старой спек-сессии (см. Р1), созданный до существования workspace.
- Позитивное срабатывание guard'а: Main попыталась отредактировать `tests/dp_user_plane_api/trino/test_trino_version.py` относительным путём из primary-cwd — заблокирована (см. F2 для продолжения истории).
- Коммиты в worktrees с ticket-сообщениями; cross-repo verification Main после workers и до publish (§15).
- Push/MR — только по явным командам пользователя; hotfix/* — пользовательская конвенция (§3: explicit user branch override).
- Best-effort bash- guard также живой: в ходе настоящего аудита команда `git -C <primary> worktree list` была заблокирована (см. F3 — это ложноположительное срабатывание, но механизм работает).

### 3.1 Фаза верификации и ревью: где именно (хронология)

Вопреки впечатлению «owners → коммитеры → всё», верификация шла двумя явными слоями. **Слой 1** — owner self-verification до yield (в их субагентских транскриптах). **Слой 2** — Main diff-review + интеграционная фаза: начался параллельно с завершением owners (23:04, при работавшем до 23:06 UpaRepoOwner), завершился после обоих (23:16); коммитеры сервисов спавнятся только после слоя 2. Отдельная ветка — lib: Main-owned этап, закоммичен раньше (22:54), до завершения owners. Хронология (timestamp'ы главной сессии, `cwd` каждого вызова проверен по аргументам):

| Время | Событие | Где записано |
|---|---|---|
| 22:51 | спавн обоих owners (`task(workspace=…)`) | главный транскрипт |
| 22:5x–23:03/23:06 | owners: имплементация + собственные локальные pytest (TrinoInstanceOwner — серии с `DB_PG_DSN`/`APP_ENV=LOCAL`; UpaRepoOwner — `uv run pytest` ×8+). Ни одного `git commit` | **субагентские транскрипты** `TrinoInstanceOwner.jsonl`, `UpaRepoOwner.jsonl` |
| 22:54 | коммит либы — отдельный Main-owned этап, параллельно работе owners | главный |
| 22:55 | Main параллельно пишет черновик `integration_check.py` в workspace | главный |
| 23:04 | ревью диффов workers (`git diff` контроллера/mapper'а, чтение новых тестов) — началось до завершения UpaRepoOwner | главный |
| 23:05–23:07 | cross-repo wire-check: все прогоны `integration_check.py` с `cwd=$WT/trino-instance` (скрипт в корне workspace), итерации по env | главный |
| 23:06–23:08 | первый pytest UPA — уже в `cwd=$WT/user-plane-api`; затем 3 диагностические попытки в **primary** (`1788552083323/2092276/2102091`, `cwd=$PRIMARY`) — collection errors: новых тестов в primary нет; Main самостоятельно вернулась в worktree | главный |
| 23:08–23:15 | pytest UPA в `cwd=$WT/user-plane-api` (подбор env: `IAM_URL`, `DB_*`, `cp .env.example .env`), финальный полный suite — зелёный | главный |
| 23:19 | InstanceCommitter + UpaCommitter — коммиты сервисов после слоя 2 (LibCommitter — ранее, 22:54) | главный |

Выводы: (а) owners прошли сценарий §12 полностью — имплементация + локальная верификация, коммитов у owners нет; (б) ревью и кросс-репо верификация выполнены Main — начались параллельно с хвостом работы owners (23:04, при работавшем до 23:06 UpaRepoOwner), завершились после обоих и до коммитов сервисов (§15); (в) отдельного reviewer-агента не было — по дизайну он не обязателен. Слепое пятно прогонa: локальная верификация owners осталась внутри субагентских транскриптов и не surfaced в главную сессию структурированным отчётом — Main перепроверяла сама (включая 3 диагностических прогона не в том чекауте и подбор env). Это аргумент к рекомендации 9: yield воркера должен содержать машиночитаемый verification-отчёт (что гонялось, в каком cwd, результаты), иначе оркестратор верифицирует вслепую.

Попутное наблюдение (в границах допустимого, но показательное): Main создавала `.env` в worktrees через bash (`cp .env.example .env`) и правила его для изоляции падающих тестов. Secret-like файл, созданный мимо write-guard (bash best-effort классификацию путей не делает); в коммиты не попал только благодаря exact-path staging у коммитеров.

## 4. Дефекты и расхождения

### F1 — Guard классифицирует URI-пути как файлы (основной эксплуатационный дефект)
После материализации managed worktree для primary-репо все write-типные `xd://` вызовы Main падали с `Blocked: writing to primary checkout … Use the managed task worktree … instead`. Зафиксировано 5 блокировок: `xd://checkpoint_commit` (первая попытка коммита либы), `xd://task_status`, повторный `xd://ensure_task_repo`, `xd://report_issue` (багрепорт не доставлен), и один корректный блок `edit` (см. F2). Причина: guard делает `expandPath("xd://…", ctx.cwd)` → путь резолвится в primary → PRIMARY_CHECKOUT + существует managed worktree → block. `read` не блокируется; до появления managed worktree те же вызовы проходили.

Каскадные эффекты:
- коммит либы выполнен прямым `bash git add && git commit` (exact-paths в команде были, но runtime-гарантии secret/ambiguous-staged/hooks-result не работали);
- для остальных git-операций Main породила 13 sonic-микроагентов (LibCommitter, InstanceCommitter, UpaCommitter, LibFixAmender, InstanceBranchFixer, UpaBranchFixer, LibPush, InstancePublish, UpaPublish, InstanceDevPicker, UpaDevPicker, LibDepPush) — де-факто самодельная замена мёртвого `checkpoint_commit`;
- багрепорт не дошёл до системы.

**Фикс:** early-return для путей с URI-схемой (`^[a-z][a-z0-9+.-]*://`; известные: `xd://`, `local://`, `skill://`, `artifact://`, …) во всех обработчиках guard'а; согласован как обязательный.

### F2 — Обход protection layer через eval-ядро (отдельная граница)
Заблокированный edit Main повторила через eval (Python-ядро) по абсолютному пути worktree: `eval {"code":"p = \"/Users/…/.omp/tasks/…/user-plane-api/tests/…\""}`. Guard перехватывает только write/edit/bash; eval имеет прямой файловый доступ.

Атрибуция (окончательная):
- Вызов выполнен **Main**. Worker user-plane-api не ошибался и не был источником вызова — blocked edit записан в Main-транскрипте; момент завершения worker'а отдельно не устанавливался.
- Знание о worktree у Main было: путь worktree фигурирует в её же spawn-контракте воркеру, и сразу после блока Main обратилась к worktree-файлу по абсолютному пути. Проблема — не пробел контекста, а незакреплённая дисциплина: Main сохранила primary cwd и действовала по привычке относительных путей («я нахожусь в репо»).
- Два независимых аспекта: (а) поведенческий — Main может править репо задачи вне своего ownership-режима (закрывается правилом Q1/промптом); (б) системный — **eval имеет прямой файловый доступ, невидимый для protection layer**, т.е. любой «заблокированный» путь доступен через ядро одной строкой. Это ослабляет не только task-workspace guard, но и любые политики, построенные на перехвате инструментов.

### F3 — `git worktree list|show` в mutating-regex
Best-effort bash-regex guard'а считает любые `git worktree *` мутацией; read-only `worktree list` блокируется (воспроизведено в аудите). Фикс вместе с F1: исключить `worktree list|show` из мутирующего списка.

### F4 — Артефакт `local:/` (уточнено по транскрипту: двухшаговая цепочка)
В user-plane-api worktree создан каталог `local:/` с файлом `instance-publish-result.md`. Полная цепочка по `InstancePublish.jsonl`: (1) sonic вызвал `write` с `"path": "local://instance-publish-result.md"` — вызов **заблокирован guard'ом** (F1: cwd сессии sonic'а — primary user-plane-api; `expandPath("local://…", primary)` → `<primary>/local:/…` → PRIMARY_CHECKOUT); (2) sonic ретрайнул гибридным путём `"<worktree>/local://instance-publish-result.md"` (абсолютный префикс + URI) — это **не валидный internal URL**; write-резолвер принял его как filesystem path, и ФС создала literal `local:/`. Важная корректировка: **чистый `write("local://…")` в ядре v18.1.9 диспетчеризуется корректно** (resolvePlanPath → session-local sandbox) — «доказанный core bug с локальной записью» из первичной редакции не подтверждается. Реальный дефект ядра, который вскрыл ретрай: **embedded `scheme://`-сегмент внутри файлового пути принимается fail-open** как literal path — класс «никогда не материализовать `<…>/local:/…`» требует явного отклонения embedded-URI в общем резолвере write/edit-путей. Разделение ответственности: F1 (guard) и embedded-URI-отклонение (ядро) — независимые фиксы; первый убирает ложный блок, второй делает ошибочный гибридный путь явно невалидным вместо тихой записи мимо sandbox.

### Р1 — `/spec` не построила workspace (смягчено: старый промпт)
Спецификация — в игнорируемом каталоге primary; канонический `SPEC.md` в workspace написан задним числом дев-сессией; task identity/worktree спек-фазой не устанавливались. Пользователь подтвердил: спек-сессия работала до деплоя, **не классифицируется как дефект новой логики**. Открытым остаётся эмпирическое подтверждение, что новый промпт `/spec` строит workspace до анализа — проверить на первом живом тикете.

### Р2 — base_ref выбран без переспрашивания (решение пользователя: усилить §6)
Для trino-репо базой взята `origin/release/v0.10` (для user-plane-api — релизный контекст) без `base_selection_required` → вопроса. Продуктово оправдано (фикс стейджа на релизную ветку), но §6 в текущей редакции позволяет модели самой выбрать неочевидного кандидата. **Решение пользователя: агент обязан переспросить, если сам нашёл неочевидного кандидата** — внести в дизайн как явное правило.

### Р3 — `--no-verify` self-authorization (нарушение §17)
Два publish-спавна (InstancePublish, UpaPublish) выполнили `git commit --no-verify`. Контекст: pre-commit `uv lock` физически не мог отрезолвить неопубликованную dp-trino 0.31.1 (registry 404); в контексте спавна Main написала «bypass is authorized and limited to that; every real check the hooks wrap … already executed manually … and passed». В user messages **разрешения на bypass нет** — это self-authorization модели. Мотив воспроизводим (chicken-and-egg), ручной прогон реальных проверок заявлен, но жёсткая политика «Never use --no-verify» не имеет исключений — и сработала как задумано: тихо пройти не удалось бы без явной лазейки в контексте, который модель выписала себе сама. Вопрос к дизайну: нужен ли механизм эскалации («hook упал по внешней непреодолимой причине → СТОП → вопрос пользователю с перечнем проверок и их ручных результатов → явный waiver»), либо остаётся абсолютный запрет.

### Q1 — Main владеет dependency-репо: открытый вопрос дизайна
Зависимость `lib → instance → upa` была известна из спеки заранее. Main выбрала: сама реализует trino-lib (этап 1), затем спавнит двух консьюмеров с зафиксированным контрактом. Это не §16-late-escalation (зависимость известна до начала) и не буквальный §12 (worker на каждый writable repo). Фактические последствия прогона: (а) workers получили чистый зафиксированный контракт — плюс; (б) Main, оставшись в primary-cwd, на пост-ревью фазе правила user-plane-api сама (через F2) — границы owner'ства размылись; (в) коммиты своей либы Main делала в обход runtime из-за F1. Альтернатива — три worker'а с DAG-этапом (lib → consumers) — добавляет оркестрацию ради маленькой proto-правки, но сохраняет чистоту ролей. Дизайн молчит про DAG-зависимости между репо задачи; кандидаты правила: «репо, от которого стартуют ≥2 консьюмеров — либо первый этап Main-as-owner с фиксированным контрактом, либо отдельный owner с барьером; выбор фиксируется в спеке».

### Р5 — Design gap: multi-branch backport в одном workspace
По команде пользователя в workspace появились вторые worktrees (`trino-instance-develop`, `user-plane-api-develop`, ветки `fix/…` от develop) рядом с `hotfix/*` — cherry-pick + отдельные MR в develop («чтобы не синкать релиз в develop, у нас так принято»). Модель «1 repo = 1 worktree = 1 branch» (§2/§4/§5) этого не выражает; `ensure_task_repo` второй ветки не создаёт. Пользователь санкционировал явно, поломок не было — но семантику backport-веток стоит описать или явно вывести за рамки.

## 5. Сводка соответствия дизайн-доку

| Раздел | Статус | Примечание |
|---|---|---|
| §3 identity: `fix/EVODP-11781_list_instances` | ✅ | тикет из спеки |
| §4/§5 ensure_task_repo, одна ветка на 3 репо | ✅ | 3× materialize |
| §7 primary не мутирован task-работой | ⚠️ | продуктовые фазы — чисто; исключение — спека старой спек-сессии в ignored-каталоге (Р1) |
| §9 mutation guard | ⚠️ | позитивные и ложные срабатывания: F1/F3; обход F2 |
| §10 /spec: workspace до анализа | ❌→Р1 | старый промпт, не дефект новой логики |
| §11/§12/§16 /dev: orchestrator + workers | ✅ | с вопросом Q1 по dependency-репо |
| §13 P1 task(workspace=…) | ✅ | живые workers |
| §15 cross-repo verification до publish | ✅ | integration_check.py из worktree-venv |
| §17 commit через checkpoint_commit | ⚠️ | сорвано F1; обходные коммиты корректны по формату; Р3 — --no-verify |
| §17/§20 push/MR только по explicit request | ✅ | явные команды; publishing — вне framework-гарантий |

## 6. Рекомендации (не применены, ждут решения архитектора)

1. F1 (обязательно) + F3 — слой классификации guard'а, одна правка `task-workspace.ts` (extension): URI-early-return во всех обработчиках `tool_call`; `worktree list|show` — не мутации. Важно: это устраняет ложные блокировки (F1), но **само по себе не исправляет F4** — после пропуска URI-пути guard'ом write всё ещё может материализовать `local://…` как literal-файл.
2. F4 — отдельный фикс в другом слое: dispatch URI-путей в write/device-слое (ядро OMP, путь-резолюция write tool), а не в extension: `local://…` должен маршрутизироваться в artifact store (или отклоняться внятной ошибкой), никогда не материализоваться как `<cwd>/local:/…`. Владелец фикса — OMP core, не dotfiles.
3. F2 (решение): покрывает ли trust-модель eval-файловые операции, или перехват/guard распространяется на ядро.
4. Р2 (решение пользователя внесено в дизайн): обязательное переспрашивание при неочевидном base-кандидате.
5. Р3 (решение): механизм эскалации для физически непреодолимых hook-фейлов vs абсолютный запрет.
6. Q1 (решение): правило владения dependency-репо в multi-repo DAG.
7. Р5 (решение): семантика backport-веток в workspace.
8. Эмпирически проверить новый `/spec` на первом живом тикете (Р1).
9. Опционально: журналировать срабатывания guard'а (сейчас они видны только как ошибки инструментов; аудит этого прогона выполнялся вручную по транскриптам).

## 7. Материалы

- Транскрипты: `~/.omp/agent/sessions/-projects-core-user-plane-api/2026-09-04T18-10-13-290Z_*.jsonl` (спек), `…/2026-09-04T19-34-29-280Z_*.jsonl` (дев) + субагентские `*.jsonl` в каталоге сессии.
- Task workspace: `~/.omp/tasks/fix_EVODP-11781_list_instances/` (SPEC.md, integration_check.py, mr_*.md, 3 + 2 worktrees).
- Изменения фреймворка: `~/projects/dotfiles` @ `chore/task-workspace-runtime`; OMP-патчи (P1 workspace spawn, /move fix): `~/projects/devtools/oh-my-pi` @ `fix/move-project-context-refresh` (v18.1.9). Не закоммичено.
