# agent-kit

Личный агентный фреймворк для Pi (`@earendil-works/pi-coding-agent`)
и Claude Code. Один git-репозиторий, который ставится в оба host'а
симлинками и даёт:

- **skills** — инструкции для агента по спецификации, реализации, ревью,
  отладке, исследованию и git-дисциплине;
- **правила** — общий контракт общения и работы с git (`rules/AGENTS.md`);
- **task-workspace runtime** — детерминированный слой, который ведёт каждую
  задачу в отдельном управляемом git worktree, не даёт агенту писать в
  основной checkout и коммитит только явно перечисленные файлы с прогоном
  hooks;
- **workflow `/spec` и `/dev`** — спецификация в Main-сессии, реализация
  субагентами-владельцами репозиториев;
- **расширения Pi** — субагенты, `ask`, todo, роли моделей субагентов, footer,
  web search и прочее.

Pi — основной host: всё, что требует расширений, живёт там. Claude Code
получает skills, правила, `/spec` и `/dev`, а task-workspace runtime — в виде
CLI `agent-kit task` и hooks плагина `agent-kit` после его однократной
регистрации.

## Установка

Нужны `bash`, `git` и [`bun`](https://bun.sh) (на нём работают `agent-kit task`
и hooks Claude Code). Для Pi-части — установленный Pi.

```sh
git clone <url> ~/src/agent-kit
~/src/agent-kit/bin/agent-kit install
```

`install` без аргументов линкует checkout в оба host'а и кладёт лаунчер
`~/.local/bin/agent-kit` (симлинк на `bin/agent-kit` этого checkout'а):

| Источник | Pi (`~/.pi/agent`) | Claude Code (`~/.claude`) |
| --- | --- | --- |
| `skills/*` | `skills/*` | `skills/*` |
| `extensions/*` | `extensions/*` | — |
| `prompts/*` | `prompts/*` | — |
| `rules/AGENTS.md` | `AGENTS.md` | `rules/agent-kit.md` |
| `rules/claude-code.md` | — | `rules/agent-kit-claude-code.md` |
| `claude-code/plugin` | — | `skills/agent-kit` (плагин, не skill; hooks — после регистрации плагина) |
| `claude-code/commands/*` | — | `commands/*` |
| `claude-code/agents/*` | — | `agents/*` |

Не каждой машине нужны оба host'а: можно поставить только один и добавить
второй позже.

```sh
agent-kit install claude-code   # только Claude Code
agent-kit install pi            # добавить Pi к выбранным host'ам
agent-kit install               # обновить ссылки выбранных host'ов
agent-kit update                # git pull --ff-only в checkout'е, затем install
agent-kit snapshot <dir>        # неизменяемый снимок HEAD для headless-хостов
agent-kit status                # выбор host'ов, состояние ссылок, владелец лаунчера
agent-kit uninstall pi          # удалить ссылки одного host'а и убрать его из выбора
agent-kit uninstall             # удалить ссылки всех host'ов и забыть выбор
```

Выбор host'ов запоминается: `install` и `update` без аргументов работают только
с выбранными host'ами и не трогают ссылки остальных. Если выбор пуст (свежая
машина или все host'ы удалены по одному), `install` ставит оба. Установки,
сделанные до появления выбора, сохраняют оба host'а. Подробности —
[ADR-0009](docs/adr/adr-0009.md).

Корни host'ов переопределяются через `PI_AGENT_DIR` и `CLAUDE_CONFIG_DIR`.

Модель владения. Инсталлер записывает, какие ссылки создал он сам
(`~/.local/state/agent-kit/links*.tsv`; рядом лежит выбор host'ов `hosts`,
база переопределяется через `$XDG_STATE_HOME`), и трогает только их — и только
пока ссылка указывает туда, куда он её поставил. Чужие файлы, свои skills и ссылки других инструментов он
не перезаписывает: если репозиторию нужно их место, это conflict и `install`
завершается с кодом 1. Повторный `install` из другого checkout'а или worktree
перенаправляет ссылки agent-kit на него. Подробности — [ADR-0007](docs/adr/adr-0007.md).

## Snapshot для headless-хостов

Headless-сессии (zavod) запускают pi с `--no-extensions` и явными путями
`-e`, поэтому не читают живой checkout: им нужен неизменяемый набор
расширений. `agent-kit snapshot <releases-dir>` создаёт такой набор и
переключает на него стабильный указатель:

```sh
agent-kit snapshot ~/.local/share/zavod/agent-kit-releases
```

Снимок лежит в `<releases-dir>/<full HEAD sha>/` и содержит копию
`extensions/`, `node_modules/` с пакетами Pi и `manifest.json` (`schema`,
`sha`, `dirty`, `createdAt`, `source`). Содержимое снимается с рабочего
дерева checkout'а; `dirty: true` в манифесте означает, что в нём были
незакоммиченные изменения, — это не ошибка. Сборка идёт во временный
каталог `.tmp-<sha>-<pid>` и переименовывается в финальное имя, поэтому
каталог под финальным именем всегда полон. Переименование не перезаписывает
существующий каталог и не вкладывает собранное внутрь него: если финальное
имя заняли, пока шла сборка, команда завершается ошибкой. `current` — единственный
изменяемый путь; он переключается атомарной заменой симлинка и не может
указывать на недособранный снимок. При ошибке команда завершается
ненулевым кодом, временный каталог удаляется, `current` не меняется.

Все операции над одним `<releases-dir>` (сборка, переключение `current`,
retention) сериализуются эксклюзивным локом. Там, где есть `flock(1)`
(GNU/Linux), это `flock` на `<releases-dir>/.lock`; на BSD-системах, где
`flock` нет (macOS), — атомарный `mkdir` каталога `<releases-dir>/.lock.d`
с записью pid и времени захвата, который снимается при выходе. Каталог,
оставшийся после `SIGKILL`, перехватывается по возрасту: старше
`AGENT_KIT_SNAPSHOT_LOCK_STALE` секунд (600 по умолчанию). Перехват
переносит только тот каталог, чей owner-line измерен как устаревший, а
держатель перед каждой записью в `<releases-dir>` перечитывает свой
owner-line и падает с ошибкой, если лок у него уже отобрали. Освобождение
лока — проверяемый перенос, а не удаление: сначала дешёвая проверка, что
временное имя `.lock.d.release-<pid>` свободно (занятое имя пропускается,
рекурсивной чистки в этом окне нет), затем один `mv`, затем сверка
owner-line уже перенесённого каталога со своим. Лок, который к моменту
освобождения принадлежит другому процессу, не переносится вовсе; если
перехват проскочил между чтением owner-line и переносом, чужой лок
возвращается на место одним rename. Если освободившееся имя `.lock.d`
успел занять третий процесс, восстановление невозможно, и это не
замалчивается: команда падает с ошибкой, называет путь
`.lock.d.release-*`, в котором остался вытесненный лок, и owner-line
вытесненного держателя, а восстановление остаётся ручным. Перехват по
возрасту использует ту же дешёвую проверку временного имени. Если имя всё же
заняли между этой проверкой и переносом, обычный `mv` вкладывает исходный
каталог в занятый; вложение обнаруживается сразу после `mv` и отменяется
через `rename(2)`, который не может вложить каталог второй раз, а если
отменить не удалось, команда падает, называя вложенный путь, вместо того
чтобы восстановить испорченную структуру. Предел у схемы честный: лок —
протокол в пространстве пользователя поверх `mkdir`, а не ядерный
дескриптор-лок, поэтому окно между последней проверкой и самим изменением
существует; во всех операциях протокола лока в нём только дешёвые проверки и
одно изменение файловой системы за один fork/exec (`mv` или `rm -rf`), и он
описан ниже.
Ожидание лока ограничено: 60 секунд по умолчанию,
переопределяется переменной `AGENT_KIT_SNAPSHOT_LOCK_TIMEOUT`. Если лок не
взят за это время, команда завершается ошибкой, ничего не меняя.
`AGENT_KIT_SNAPSHOT_LOCK=auto|flock|mkdir` принудительно выбирает механизм
блокировки (`auto` — единственное поведение по умолчанию: flock, если он
есть, иначе mkdir); значение нужно тестам, чтобы прогонять обе ветки на
одной машине.

Каталог под финальным именем принимается только после строгой проверки:
наличие `extensions/subagents/index.ts`, пакетов Pi в `node_modules` и
манифеста, который разбирается как ровно пять полей, записанных этой
командой. Иначе это недособранный артефакт, и `current` на него не
переключается. Ошибка retention (старый снимок не удаляется) не фатальна:
команда выводит одну ограниченную строку предупреждения и всё равно
завершается с кодом 0, потому что `current` уже указывает на новый снимок.

Retention удаляет кандидатов по одному и перед каждым удалением заново
проверяет владение локом и заново резолвит `current`: снимок, на который
`current` указывает, пропускается с предупреждением, а процесс, потерявший
лок, падает с ошибкой, не трогая остаток списка. Рекурсивный обход прав
(`chmod -R u+rwX`) выполняется до проверок, а само удаление — один
`rm -rf` без обхода внутри. Поэтому между последней проверкой
(перечитывание owner-line и резолв `current`) и `rm` остаётся окно в один
fork/exec. Если в этом окне лок всё-таки перехватили, возобновлённый
процесс может удалить каталог, который новый владелец уже сделал `current`;
проверка в конце цикла замечает потерю лока и завершает команду с
ограниченной ошибкой, а `agent-kit snapshot` восстанавливает снимок
повторным запуском. Закрыть окно целиком без ядерного примитива, который
проверяет и удаляет одной операцией, нельзя.

`<releases-dir>/current` — стабильная точка входа для `pi_command`,
например `<releases-dir>/current/extensions/<name>`. Повторный запуск для
уже снятого HEAD ничего не копирует: команда проверяет снимок, поправляет
`current`, применяет retention и выходит. `node_modules` копируется
хардлинками из предыдущего `current` (при первой синхронизации — из
`node_modules` checkout'а); если хардлинки невозможны, например между
файловыми системами, используется обычная копия. На BSD-системах, где у `cp`
нет `--link`, хардлинки создаёт `pax -rwl`; обычная копия остаётся последним
вариантом. Снимки не переписываются на месте, поэтому общие inode
безопасны. Хранятся `current` и 5 самых новых снимков; более старые
каталоги удаляются.

## Задачи и worktree

Центральная идея: агент не правит основной checkout. Любая изменяющая задача
получает свой git worktree, а изменения в нём делает субагент-владелец.

- **Задача** идентифицируется веткой. Ветка берётся от пользователя или из
  тикета (`feat/KEY-123_short_slug`); без тикета агент спрашивает, разрешена ли
  работа без него (`chore/short_slug`). Тикеты и `base_ref` агент не
  придумывает: базу выбирает runtime, если пользователь или спецификация не
  назвали её явно.
- **Task workspace** — каталог задачи в `~/.agent-kit/tasks/` (имя — ветка,
  `/` заменяется на `_`; корень переопределяется `AGENT_TASK_ROOT`). Там лежат worktree всех затронутых
  репозиториев и артефакты задачи: `SPEC.md`, ADR, `specs/<repo>.md`.
- **Managed worktree** — worktree репозитория внутри task workspace,
  единственная цель записи. Основной checkout (primary checkout) остаётся как
  был, даже если он грязный.
- **Lane** — дополнительный worktree той же задачи на другой ветке. Только для
  настоящей второй ветки (backport, release/hotfix), а не «чтобы отдельно
  потестить».
- **RepoOwner** — субагент, который владеет ровно одним managed worktree и
  делает в нём все изменения. Main-сессия управляет задачей, ревьюит и
  интегрирует, но сама репозитории задачи не редактирует.
- **Checkpoint commit** — коммит через runtime: стейджит ровно перечисленные
  пути, отказывается коммитить в primary checkout и файлы, похожие на секреты,
  всегда прогоняет hooks, не пушит. `--no-verify` запрещён везде.
- **Candidate commit** — граница верификации. RepoOwner может отчитаться
  `done` только с закоммиченного и проверенного после коммита состояния; runtime
  проверяет, что HEAD сдвинулся, а дерево чистое
  ([ADR-0002](docs/adr/adr-0002.md), [ADR-0003](docs/adr/adr-0003.md)).
- **Guard** — git-shim в `PATH` блокирует изменяющие git-команды на primary
  checkout репозитория, у которого есть managed worktree, а также
  `--no-verify` и перенаправление через `--git-dir`/`--work-tree`. Второй
  guard запрещает инструментам редактирования писать в отслеживаемые файлы
  primary checkout. Это защита от ошибок маршрутизации, а не песочница: блок
  означает «иди в worktree», а не «сделай то же самое через `sed`».

Операции runtime: `status`, `ensure` (создать или переиспользовать worktree),
`remove-lane`, `teardown`, `commit`. В Pi это инструменты `task_status`,
`ensure_task_repo`, `remove_task_lane`, `teardown_task_repo`,
`checkpoint_commit`; в Claude Code — `agent-kit task <op> '<json>'` с JSON на
входе и выходе. Ядро одно: [`extensions/task-workspace`](extensions/task-workspace/README.md).

### `/spec` и `/dev`

- **`/spec [задача]`** — Main определяет задачу, создаёт worktree и исследует
  код уже в нём. По ходу использует `system-understanding`,
  `engineering-research`, `code-archaeology`, `prototype`, а факты и решения
  собирает и оформляет через `specification` в `SPEC.md` в task workspace.
  Продуктовый код в этом режиме не пишется. Готово, когда реализация не
  требует угадывать намерения.
- **`/dev [задача]`** — Main переиспользует worktree и `SPEC.md`, запускает по
  одному RepoOwner на каждый изменяемый репозиторий (независимые —
  параллельно), проверяет объективные git-факты после их отчёта, решает,
  нужен ли независимый ревьюер, и чинит дефекты через нового владельца.
  Внутри владельцев работают `implementation`, `tdd`, `verification-design`
  и `git-commit`.

Политика целиком — в skill [`git-task`](skills/git-task/SKILL.md) и его
`references/`.

## Pi

В Pi ставятся расширения из `extensions/` и промпты из `prompts/`
(`/spec`, `/dev`, `/neponel` — пересказать предыдущий ответ проще).

| Расширение | Что делает |
| --- | --- |
| [`task-workspace`](extensions/task-workspace/README.md) | Инструменты task workspace, git-shim в `bash`, guard на `write`/`edit` |
| [`subagents`](extensions/subagents/README.md) | Инструмент `subagent` (`spawn`, `status`, `steer`, `follow_up`, `wait`, `result`, `respond`, `cancel`); workspace-режим для RepoOwner с проверкой готовности, дедлайном и проверкой settled-состояния; явная модель (`model=provider/id[:thinking]`) и фиксированные роли `explore`/`helper`/`review`/`owner` с привязками в `subagent-roles.json` (`/subagent-role`); `/subagents [kill-all]`. Быстрое переключение модели сессии — штатная настройка Pi `enabledModels` |
| [`ask`](extensions/ask/README.md) | Инструмент `ask`: диалог с пользователем в TUI, select/input в RPC, fail-closed без интерфейса; у субагентов вопрос уходит в Main |
| [`todo`](extensions/todo/README.md) | Инструмент `todo` с фазами, HUD-виджет, напоминания, `/todo` |
| [`web-search`](extensions/web-search/README.md) | Инструмент `web_search` через бэкенд ChatGPT Codex по логину `/login openai-codex` |
| [`session-title`](extensions/session-title/README.md) | Имя сессии и заголовок терминала по первому промпту, дешёвой моделью |
| [`footer`](extensions/footer/index.ts) | Footer: модель, thinking, ветка, стоимость, заполненность контекста; `/footer` |
| [`perf-stats`](extensions/perf-stats/index.ts) | Под ответом: время до первого токена, tok/s, токены, cache reads |
| [`continue-shortcut`](extensions/continue-shortcut/README.md) | Ввод `.` или `c` — скрытая команда «продолжай незаконченное» вместо сообщения |
| [`update-check`](extensions/update-check/index.ts) | Тост при старте, если checkout отстал от upstream или стоит не на основной ветке |
| `proxy-toggle.ts`, [`proxy`](extensions/proxy/proxy-lib.ts) | `/proxy on\|off\|status`, адрес из `PI_PROXY`; настройка доходит и до живых субагентов |
| [`inspection-channel`](extensions/inspection-channel/README.md) | Read-only канал инспекции субагентов и задач по унаследованным fd ([ADR-0006](docs/adr/adr-0006.md)) |
| [`agent-events`](extensions/agent-events/README.md) | Телеметрия жизненного цикла в Warp (OSC 777) |

Субагенты запускаются как `pi --mode rpc --no-extensions` со своим
bridge-расширением; остальные расширения в них не грузятся.

## Claude Code

Claude Code получает:

- skills из `skills/` и правила в `~/.claude/rules/` (подхватываются
  автоматически, `CLAUDE.md` остаётся под личные инструкции);
- `rules/claude-code.md` — как Pi-термины из skills ложатся на Claude Code:
  `skill://<name>` → Skill tool, `ask` → `AskUserQuestion`, task-инструменты →
  `agent-kit task`, RepoOwner → субагент Agent tool с абсолютным путём к
  worktree;
- команды `/spec` и `/dev` (`claude-code/commands/`);
- роли субагентов (`claude-code/agents/`, симлинки в `~/.claude/agents/`):
  роли `explore` → `Explore` (переопределяет встроенный; `model: haiku`,
  `effort: low`, только Read/Grep/Glob), `owner` → `repo-owner` (RepoOwner для
  managed worktree; `model: sonnet`, `effort: medium`), `review` →
  `general-purpose` с `model: opus` в вызове Agent, `helper` → `general-purpose`
  без `model`. Модели в определениях заданы алиасами; новый тип агента
  заводится только ради своего system prompt или набора tools
  ([ADR-0010](docs/adr/adr-0010.md), [ADR-0011](docs/adr/adr-0011.md));
- плагин `agent-kit` (`claude-code/plugin`): инсталлер линкует каталог в
  `~/.claude/skills/agent-kit` как skills-directory plugin, а не как skill —
  в каталоге нет `SKILL.md`, его грузит загрузчик плагинов. Hooks плагина и
  его `bin/` работают только после однократной регистрации плагина в Claude
  Code; по умолчанию плагин не зарегистрирован и hooks не включены.
  `agent-kit` в `PATH` даёт `~/.local/bin/agent-kit` из инсталлера, не `bin/`
  плагина. После регистрации плагин включает:
  - `SessionStart` → `agent-kit task hook session-start`: включает git-shim для
    всех Bash-команд сессии и её субагентов и экспортирует `AGENT_KIT_POLICY`;
  - `PreToolUse` на `Edit|Write|MultiEdit|NotebookEdit` → `agent-kit task hook
    pre-tool-use`: guard записи в primary checkout.

Рекомендуемая настройка пользователя в `~/.claude/settings.json` (agent-kit
`settings.json` не пишет). Уровень effort по моделям:

```json
"modelSettings": {
  "claude-haiku-5-5":  { "autoCompactWindow": 130000, "effortLevel": "high" },
  "claude-sonnet-5-5": { "effortLevel": "medium" },
  "claude-opus-5-5":   { "effortLevel": "medium" }
}
```

Подмена модели на машине: `env` с `ANTHROPIC_DEFAULT_HAIKU_MODEL`,
`ANTHROPIC_DEFAULT_SONNET_MODEL`, `ANTHROPIC_DEFAULT_OPUS_MODEL`
([model-config](https://code.claude.com/docs/en/model-config)). Подмена общая
для алиаса, а не для роли. `effort` во frontmatter агента перекрывает effort
сессии, но не `CLAUDE_CODE_EFFORT_LEVEL`. Открытый риск: документация явно не
говорит, что `ANTHROPIC_DEFAULT_*` применяется к алиасу во frontmatter
субагента; проверяется эмпирически ([ADR-0011](docs/adr/adr-0011.md)).

Ограничения ([ADR-0008](docs/adr/adr-0008.md)):

- Без `bun` hooks молча пропускают всё (fail-open), а `agent-kit task`
  возвращает ошибку.
- Если управляемые настройки запрещают сторонние hooks
  (`allowManagedHooksOnly`), плагин загружается, но guard не работает.
  Проверка: `[ -n "$AGENT_KIT_POLICY" ] && echo guarded || echo unguarded`.
  В режиме unguarded правила маршрутизации те же, их соблюдает сам агент.
- В Claude Code нет протокола субагентов Pi: ни проверки готовности, ни
  дедлайна, ни `needs_input`. Владелец с вопросом возвращает `blocked`, Main
  отвечает ему через `SendMessage`.
- В sandbox-режиме Bash сетевые операции (`git push`/`fetch` по SSH, `gh`,
  `glab`) агент не выполняет, а отдаёт пользователю готовую команду `! …`.

## Skills (23)

Процесс и git:

- [`git-task`](skills/git-task/SKILL.md) — режим задачи, идентичность, worktree, RepoOwner, ревью
- [`git-commit`](skills/git-commit/SKILL.md) — политика checkpoint-коммитов
- [`change-request`](skills/change-request/SKILL.md) — PR в GitHub / MR в GitLab через `gh`/`glab`
- [`lazy-mr-review`](skills/lazy-mr-review/SKILL.md) — ревью MR по ссылке, комментарии публикуются только по явному выбору
- [`handoff`](skills/handoff/SKILL.md) — сжать разговор для следующей сессии

Спецификация и исследование:

- [`specification`](skills/specification/SKILL.md) — добыть факты, выяснить решения вопросами, не угадывая, и превратить намерения в контракт реализации
- [`system-understanding`](skills/system-understanding/SKILL.md) — как подсистема работает на самом деле
- [`code-archaeology`](skills/code-archaeology/SKILL.md) — почему код устроен именно так
- [`engineering-research`](skills/engineering-research/SKILL.md) — исследование по первоисточникам
- [`prototype`](skills/prototype/SKILL.md) — одноразовый spike, чтобы закрыть неопределённость

Реализация и отладка:

- [`implementation`](skills/implementation/SKILL.md) — реализация по согласованному плану минимальными связными диффами
- [`tdd`](skills/tdd/SKILL.md) — red-green от поведения, где есть тестовый шов
- [`verification-design`](skills/verification-design/SKILL.md) — минимальный достоверный план проверки и локальный harness, чтобы запустить, проверить и прибрать приложение
- [`diagnosing-bugs`](skills/diagnosing-bugs/SKILL.md) — отладка от воспроизведения и ранжированных гипотез

Ревью и проверка:

- [`code-review`](skills/code-review/SKILL.md) — верность контракту и инженерное качество, включая независимую fresh-context проверку закоммиченного кандидата с `PASS`/`FAIL`
- [`blast-radius`](skills/blast-radius/SKILL.md) — неочевидные поломки ниже по течению
- [`security-review`](skills/security-review/SKILL.md) — security-линза

Дизайн:

- [`simple-design`](skills/simple-design/SKILL.md) — минимально достаточный дизайн и где живут ответственность, состояние, интерфейсы и швы, когда сложность оправдана

Тексты и мета:

- [`unslop`](skills/unslop/SKILL.md) — редакторская правка текста от AI-паттернов
- [`editorial-html-report`](skills/editorial-html-report/SKILL.md) — отчёт одним HTML-файлом
- [`skill-design`](skills/skill-design/SKILL.md) — проектирование и чистка skills и AGENTS-инструкций

Skills ссылаются друг на друга как `skill://<name>`.

UI-работа требует двух skills, которые живут вне agent-kit: `interface-design`
и `design-taste-frontend` (на этом хосте — `~/.agents/skills/`). Инсталлер
agent-kit их не ставит; для продуктового UI, дашбордов и лендингов подключайте
их отдельно.

Скилл `fleet` живёт в репозитории Fleet: <https://github.com/kaktusss123/fleet>.

## Разработка

Раскладка репозитория и есть желаемое состояние установки: манифестов и
списков нет. Новый skill — каталог в `skills/` с `SKILL.md` (`name` совпадает
с именем каталога, есть `description`); новое расширение Pi — каталог в
`extensions/`. После добавления — `agent-kit install`.

Тесты:

```sh
tests/installer/run.sh [-v]     # инсталлер в песочнице $HOME
tests/layout/run.sh             # запрещённые каталоги и инварианты раскладки
tests/skills/run.sh             # frontmatter, references, ссылки skill://
tests/snapshot/run.sh           # snapshot CLI: атомарность, блокировка, retention,
                                 # строгая проверка манифеста, hardlink reuse
bun test extensions/<name>/     # расширения (bun:test)
```

Тестам расширений нужны пакеты Pi в `node_modules/` (gitignored): симлинки
`@earendil-works/pi-coding-agent`, `pi-ai`, `pi-tui` и `typebox` на
установленный Pi. В managed worktree runtime создаёт их сам. Live-проверки в
`extensions/*/live/` запускают настоящий `pi` и в обычный прогон не входят.

## Документация

- [`docs/design-progress.md`](docs/design-progress.md) — индекс архитектурных этапов A1–A9 и их статус
- [`docs/adr/`](docs/adr/) — решения:
  - [0001](docs/adr/adr-0001.md) — agent-kit как самостоятельный Pi-first фреймворк
  - [0002](docs/adr/adr-0002.md) — candidate commit как граница финальной верификации
  - [0003](docs/adr/adr-0003.md) — проверка settled-состояния при `done` RepoOwner
  - [0004](docs/adr/adr-0004.md) — восстановление после падения через Pi session + Git, без durable Run runtime
  - [0005](docs/adr/adr-0005.md) — headless-режим на штатном `pi --mode rpc`
  - [0006](docs/adr/adr-0006.md) — read-only канал инспекции
  - [0007](docs/adr/adr-0007.md) — один checkout в несколько host'ов
  - [0008](docs/adr/adr-0008.md) — task-workspace runtime в Claude Code: CLI + плагин
  - [0009](docs/adr/adr-0009.md) — выбор host'ов при установке
  - [0010](docs/adr/adr-0010.md) — роли субагентов в Claude Code
  - [0011](docs/adr/adr-0011.md) — алиасы моделей и словарь ролей субагентов в Claude Code
- [`docs/specs/`](docs/specs/) и [`docs/research/`](docs/research/) — спецификации и исследования этапов
- README расширений в `extensions/*/README.md` — контракты конкретных расширений
