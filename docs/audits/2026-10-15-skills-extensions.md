# Аудит skills и расширений — 2026-10-15

База: `origin/main`, `b1ab96a`. Ветка: `chore/audit_skills_extensions` (ticketless, авторизовано пользователем).
Охват: все 25 skills, все 15 точек расширений Pi (14 каталогов в `extensions/` плюс корневой `proxy-toggle.ts`),
Claude Code ассеты (`claude-code/agents`, `claude-code/commands`, `claude-code/plugin`), контракт установщика
(`tests/installer`), раскладка (`tests/layout`), валидация skills (`tests/skills`).

Метод по каждому пункту — один из четырёх, без подмен:
инспекция исходников; детерминированные тесты; проверка на реальном host;
недоступная live-проверка (честно отмечена как пропуск, не как «зелёная»).

## Исправленные дефекты

### 1. Снапшот ревью (skills/lazy-mr-review/scripts/review_snapshot.py)

Нарушение обещанной read-only дисциплины: переданный `--clone` получал `fetch` в себя
и регистрировал worktree в метаданных пользовательского клона.
Дополнительно: общий чекаут на проект затирал соседние MR; свежий `--no-clone`
не забирал MR-head ref; молчаливый `fetch origin` вместо совпавшего remote;
грязный переиспользуемый чекаут мог выдать SHA, не соответствующий содержимому;
коллизии слагов (`group/a-b` vs `group-a/b`); чужой каталог на месте чекаута
молча использовался.

Исправление: изолированный стор под temp root (seed локальным клоном из
пользовательского пути либо свежим клоном с сервера); пользовательский клон —
только источник, в него нет fetch и нет регистраций. Fetch MR-head ref явно в
обоих путях с проверкой `FETCH_HEAD == head_sha`; remote для fetch — совпавший
remote клона, а не всегда `origin`. Идентичность чекаута — `host/project/iid`
плюс короткий хэш точной пары host/project (коллизии слагов исключены); та же
идентичность у diff-файлов. Переиспользуемый чекаут проверяет принадлежность
стору через `git-common-dir`, отказывается от грязного состояния с явной ошибкой
(без автосброса) и от чужого каталога. Покрытие — офлайн `scripts/selftest.sh`
на локальных git-фикстурах: грязный клон-источник нетронут (status, worktree list,
отсутствие FETCH_HEAD), два MR одного проекта на разных SHA, MR-only ref,
повторное использование, сдвинувшийся head, коллизия слагов, чужой каталог,
грязный чекаут. Итог: 55/55.

### 2. Падения на custom-событиях (agent-events, session-title, todo)

Host при idle custom-поворотах (например скрытая continue-директива через
`sendMessage(..., { triggerTurn: true })`) шлёт `before_agent_start` с сообщением,
а не с `prompt`: `agent-events` падал в `truncateCodePoints(undefined)`,
`session-title` — на `event.prompt.trim()`, у `todo` та же точка в dormant-ветке
eager-prelude (`eager: "off"`). Исправление: защитное чтение `prompt`,
совместимое с обеими формами события — старый user-shape и новый custom-shape.
Поведение: `agent-events` всё равно открывает логический ран (без текста запроса),
`session-title` пропускает генерацию заголовка и ждёт первый реальный промпт,
`todo` сохраняет `resetCycle()` на каждом повороте и пропускает prelude без текста.
Покрытие: поведенческие тесты вызова обработчиков (`index.test.ts`,
`handler.test.ts` в обоих расширениях). Для `todo` eager-ветка dormant —
тест фиксирует границу контракта (нет падения, нет инъекций), а не сам prelude;
это ограничение указано честно.

### 3. Прокси-стенд (extensions/proxy/rig-child.mjs, proxy-rig.test.ts)

Базовые падения ON-тестов (`UND_ERR_PRX_CONN` вместо `HEADERS_TIMEOUT`) —
дефект стенда, а не продукта: диспетчер строился с `proxyTunnel: true`, а локальный
прокси умел только plain forward без CONNECT. Исправление: loopback-прокси теперь
говорит и absolute-form forwarding, и CONNECT-туннелирование (TCP-pipe с ответом
502 вместо зависания); ON-кейсы доказуемо идут через прокси — в RESULT добавлены
`connectCount`/`backendHits`, тесты ассертят их. Комментарий про absolute-form GET
исправлен, недоступная ссылка на внешнее исследование убрана. Итог: 5/5, включая
оба ON-кейса через реальный туннель.

### 4. Противоречия между skills

- `git-commit/references/checkpoint.md` требовал светить deferred-hook gap в MR,
  `change-request` запрещал и создавать MR, и упоминать незакрытые проверки.
  Решение: publication gate сохраняется для required-проверок; deferred gap виден
  в task-репортах и неопубликованных драфтах, создание блокируется до закрытия gap.
  `description.md`: Verification — только позитивные факты, но материальные
  ограничения optional/advisory-проверок допустимы коротко в `Review notes`;
  незакрытый required-чек блокирует создание. `github.md`/`gitlab.md`: явное
  требование смягчено до «resolved» — единственный remote с default-веткой при
  запрошенной публикации ambiguity не создаёт; выбор среди нескольких кандидатов,
  push/fork — только через пользователя.
- Независимый ревьюер хардкодил опциональный класс `smart`: теперь `smart`, когда
  он есть в текущем инвентаре, иначе явный `modelClass=default`; fail-closed при
  неразрешимом классе сохранён (`git-task/SKILL.md`, `prompts/dev.md`).
- `security-review/SKILL.md`: короткая progressive-disclosure маршрутизация по
  reference-файлам границы/языка плюс обязательное чтение `finding-verification.md`
  до публикации уязвимости.
- `git-task/references/repo-owners.md`: несуществующий пример
  `tests/dp_user_plane_api/trino` заменён описательным плейсхолдером.
- Непрозрачные ссылки в активных комментариях (`SPEC R1/R2/R5/D4`, `b2-rig`)
  заменены самодостаточными формулировками со смыслом; легитимные tracked-ссылки
  (ADR, repo-local пути) и stage-метки в workspace-оркестрации не тронуты.
  Общее правило — коротко в `skill-design` (уровень авторства) и одна строка-проверка
  в `code-review` (уровень ревью), без копирования политики повсеместно.

### 5. Валидация skills (tests/skills/run.sh)

Сканировались только `SKILL.md` + непосредственные `references/*.md`: вложенные
байдинги (`references/claude-code/*.md`) и ссылки из agent-определений выпадали.
Теперь: все `*.md` под каталогом skill для обоих видов file-refs и `skill://`;
проверка `skill://` и `skills/.../references/...` в `claude-code/agents/*.md`;
коммиттед-фикстуры `tests/skills/fixtures/nested-refs` + regression probe внутри
`run.sh` (битый nested skill ловится, валидный проходит). Итог: 148/148.

## Не дефекты (проверено, не чинилось)

- Подозрение «хуки skills-dir не грузятся» — опровергнуто: `claude plugin list`
  показывает `agent-kit@skills-dir · loaded`, оба хука находятся, `plugin validate`
  проходит (данные runtime-аудитора, host 2.1.300).
- Архитектура установки/плагина, host provider SDK, пользовательские настройки —
  вне скоупа, не менялись.

## Официальные источники и сравнение (доступ 2026-10-15)

Полные выгрузки — вне репозитория (`/tmp/agentkit-*`, сняты helper-агентом 2026-10-15):

- GPT-6: `Using GPT-6` (семейство Astra/Sol/Luna),
  https://developers.openai.com/api/docs/guides/latest-model/gpt-6-astra.md —
  наблюдения: чувствительность к конфликтам skills, преждевременные уточнения,
  многословность, избыточное тестирование, недоделегирование. Применено как
  суждение (чёткие границы stop/completion, пропорциональное тестирование,
  никаких лишних подтверждений), а не дословные шаблоны; выдуманной иерархии
  инструкций, противоречащей host/system-правилам, не ввезено.
- Общая: `Claude prompting best practices`,
  https://platform.claude.com/docs/en/build-with-claude/prompt-engineering/claude-prompting-best-practices —
  чёткость, прогрессивное раскрытие, проверяемые критерии готовности.
- Haiku 5.5: `Prompting Claude Haiku 5.5`,
  https://platform.claude.com/docs/en/build-with-claude/prompt-engineering/prompting-claude-haiku-5-5 —
  low-режим пропускает поиск/проверки и рано останавливается в длинных агентских
  промптах. Роль Explore-агента оставлена узкой (только чтение, явный скоуп,
  честные ограничения) вместо глобального повышения стоимости модели.
- Sonnet 5.5: `Prompting Claude Sonnet 5.5`,
  https://platform.claude.com/docs/en/build-with-claude/prompt-engineering/prompting-claude-sonnet-5-5 —
  medium для чётких агентских кодинг-задач, low — пропуски валидации, high —
  непрошеные дополнения. Роль RepoOwner на Sonnet-medium соответствует;
  явное решение о ревью и проверка точных имён инструментов уже закрывают часть
  рисков инициативы/скоупа.
- Opus 5.5: `Prompting Claude Opus 5.5`,
  https://platform.claude.com/docs/en/build-with-claude/prompt-engineering/prompting-claude-opus-5-5 —
  text-only end_turn не доказательство завершения, bounded 2–3 продолжения,
  ожидание фоновой работы. Существующие `report_result`/settled Git-проверки уже
  отвергают преждевременное prose-only завершение owner; новой provider/retry
  архитектуры без воспроизводимой repo-проблемы не вводилось.
- Замены 4.5/4.6-гайдами не делалось: сравнивались именно страницы 5.5
  (существование подтверждено прямыми выгрузками, сомнений нет).
- Model-specific API/provider-рычаги принадлежат host Pi/Claude, а не
  generic-инструкциям репозитория — вынесены на owning boundary.

## Ограничения

- Live-проверки недоступны там, где нет сети/кредов (glab/gh flows против
  реального GitLab, публикация) — отмечены пропусками, не «пройдено».
- `todo` eager-prelude dormant (`eager: "off"`): краш-ветка покрыта граничным
  тестом, полный prelude при `preferred` — нет.
- Контракт событий проверен по двум объявлениям: установленный host 1.2.0
  (дискриминированный `messageType` user/custom) и SDK в worktree-node_modules
  (1.0.4, только user-shape). Гарды написаны под обе формы; версии окружения в
  продукт-комментарии не вшивались (меняются независимо) — факты здесь, в отчёте.
  Полное live-покрытие обоих SDK тестами не заявляется.
- Claude host-проверки (2.1.300, plugin list/details/validate, SessionStart/PreToolUse)
  выполнены runtime-аудитором read-only и здесь пересказаны, а не перепрогонялись.

## Верификация кандидата

- `tests/layout/run.sh`: 18 pass.
- `tests/installer/run.sh`: 35 pass.
- `tests/skills/run.sh`: 148 pass (было 144: +2 agent-проверки, +2 probe).
- `bash skills/lazy-mr-review/scripts/selftest.sh`: 55 pass, 0 fail (было 32/7 на старте до фикса фикстур).
- `bun test extensions`: полный прогон в финальной проверке (база: 988 pass, 2 skip, 2 fail — оба fail были стендом прокси, исправлены).
- Посткоммитная проверка — на точном коммите кандидата.
