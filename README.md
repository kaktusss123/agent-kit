# agent-kit

Единый источник общей agent-инфраструктуры: shared-скиллы, инвариантные
от рантайма, плюс runtime-specific части для pi, OMP (oh-my-pi) и OpenCode.
Один обычный git-репозиторий, без vendored-снапшотов и per-repo инсталлеров.

## Структура

```
shared/skills/<name>/          канонические runtime-independent скиллы
runtimes/pi/                   pi: extensions/, skills/, prompts/
runtimes/omp/                  OMP: extensions/, skills/, prompts/,
                               managed-skills/, docs/, RULES.md, ...
runtimes/opencode/             OpenCode: skills/, agents/, commands/,
                               plugins/, tool/, AGENTS.md
bin/agent-kit                  инсталлер (install / uninstall / status)
tests/installer/run.sh         тесты ownership-семантики инсталлера
```

Раскладка репозитория и есть desired state — отдельных манифестов или
конфигов со списками файлов нет. Runtime-адаптер знает только convention'ы
своего рантайма (куда класть skills/extensions/...). Правило размещения:
**colocate first, extract shared second** — в `shared/` попадает только то,
что реально используется несколькими рантаймами; похожие, но разные
реализации (например, task-workspace у pi и у OMP) живут рядом в своих
`runtimes/...`. Один и тот же логический item в `shared/skills/foo` и
`runtimes/<rt>/skills/foo` — configuration error, инсталлер такое отвергает.

`shared/skills/*` означает «можно ставить в каждый поддерживаемый
skill-runtime». Если скилл зависит от рантайма, которого у части рантаймов
нет, в каталоге скилла создаётся файл `runtimes` со списком имён через
пробел (`pi omp`) — скилл ставится только в перечисленные. Нет файла —
ставится везде. Это единственное исключение из правила «раскладка и есть
desired state». Сейчас так помечены `git-task` и `git-commit`: оба
завязаны на task-workspace runtime (`ensure_task_repo`,
`checkpoint_commit`, `workspace_agent`), которого нет в OpenCode; для
OpenCode своя colocated-версия коммит-скилла лежит в
`runtimes/opencode/skills/git-commit`. Если когда-нибудь появится
по-настоящему portable commit skill — объединим, а пока colocate first.

Runtime-конфиги (`config.yml`, `mcp.json`, `opencode.json`, model-profiles)
в link/reconcile-модель не входят: machine-local и генерируемое рантаймом
владеть из репозитория нельзя. `runtimes/omp/config.yml` и `mcp.json` лежат
в репозитории как portable-справочные копии, но не устанавливаются.

## Install

```sh
agent-kit install              # все рантаймы, найденные в PATH (pi, omp, opencode)
agent-kit install pi           # явно один рантайм
agent-kit install pi omp
agent-kit uninstall [runtime]  # снять ссылки (по умолчанию — все свои)
agent-kit status               # состояние ссылок по рантаймам
```

- `install` без аргументов определяет рантаймы по бинарям и ставит только
  найденные; остальные показывает как skipped.
- Явный `install <rt>` работает даже без бинаря в PATH (только warning).
- Установка — это symlinks из нативных директорий рантайма в этот checkout,
  никогда копирование. Механизм — деталь инсталлера, не конфигурация.
- Каждый `install` заодно ставит/обновляет команду
  `~/.local/bin/agent-kit -> <этот checkout>/bin/agent-kit` (используемый
  checkout подменяется при установке из worktree). После первого
  `./bin/agent-kit install` команда доступна как просто `agent-kit`.
  Лаунчер владеется отдельной ownership-записью (`command.tsv` рядом со
  state) по тем же правилам, что и остальные ссылки: чужой symlink или
  реальный файл на этом пути — warning без перезаписи, вручную
  перенаправленный свой — освобождается без удаления. `uninstall` команду
  не снимает.
- Повторный `install` — reconcile: повторный запуск из того же checkout'а
  ничего не меняет; запуск из другого checkout'а/worktree переносит ссылки
  agent-kit на него (предыдущий checkout не модифицируется). Так удобно
  переключаться между primary checkout'ом и task worktree.
- Отдельных `--prune` / `--force` / update-команд нет: item, удалённый из
  репозитория, убирается при следующем `install`.

Необязательные overrides корней: `PI_AGENT_DIR` (`~/.pi/agent`),
`OMP_AGENT_DIR` (`~/.omp/agent`), `OPENCODE_CONFIG_DIR`
(`~/.config/opencode`), `AGENT_KIT_ROOT` (используется тестами).

## Ownership model

Состояние — `~/.local/state/agent-kit/links.tsv` (или `$XDG_STATE_HOME`),
одна строка на ссылку: `runtime`, путь внутри рантайма, source. Инварианты:

1. Управляется только ownership set — то, что записано в state. Чужие файлы
   и ссылки в директориях рантайма никогда не сканируются и не удаляются.
2. Запись в state не даёт права удалить путь. Ссылка снимается/переносится
   только если её текущая цель — в точности та, которую agent-kit записал
   последним `install`. Ссылка, перенаправленная вручную, не трогается:
   ownership освобождается, а желание занять этот путь сообщается как
   conflict (без `--force`; решение — вручную разобрать и перезапустить).
3. Item удалён из репозитория: если ссылка всё ещё наша — снимается; если
   цель уже отсутствует — просто чистится state; если цель подменили — не
   трогается, ownership забывается.
4. Real files, каталоги и чужие symlinks на желаемом пути — conflict,
   молча не перезаписываются никогда.
5. Corrupt state не может расширить множество допустимых удалений — только
   сузить. Каждая запись валидируется до любого обращения к файловой
   системе: ровно три поля, безопасный относительный destination без
   traversal (путь гарантированно внутри корня рантайма), абсолютный
   source; мусорные строки отбрасываются с warning'ом.

`uninstall` снимает только ссылки, которые agent-kit доказуемо владеет
(тот же критерий); остальное освобождается без удаления.

## Разработка из worktree

`agent-kit install` из worktree переключает управляемые ссылки на этот
worktree. Ссылки и state — единственное, что меняется; содержимое других
worktree не затрагивается. `status` показывает, какой checkout сейчас
активен (up to date / relink needed).

## Тесты

```sh
tests/installer/run.sh      # 14 сценариев ownership-семантики, песочница с фейковым $HOME
tests/installer/run.sh -v   # с выводом инсталлера
```

Покрывают: autodetect, явный install без бинаря, первый install, идемпотентность,
переключение checkout'ов, нетронутость чужих ссылок и real-file конфликтов,
ручное перенаправление managed-ссылки, prune удалённых items (включая
подменённую ссылку), scope uninstall, corrupt state, пути с пробелами,
reject дубликатов. Юнит-тесты расширений лежат рядом с расширениями
(`bun test runtimes/pi/extensions/<name>`, `bun test runtimes/omp/tests`).

## Переезд со старой схемы

- pi: ссылки от `pi-tuning/install.sh` agent-kit'у не принадлежат — первый
  `agent-kit install pi` сообщит по ним conflict; один раз снять старые
  ссылки (`install.sh` не имеет uninstall, ссылки удаляются вручную) и
  перезапустить.
- OMP: пока раскладку `~/.omp/agent` ведёт chezmoi (копии), `agent-kit
  install omp` будет честно сообщать конфликты на реальных файлах. Перенос
  OMP на agent-kit — убрать `dot_omp` из chezmoi-менеджмента, удалить
  скопированное и прогнать `install omp`.
- OpenCode: модель `vendor/opencode-bundle` + `install-vendored-bundle.sh`
  заменена прямыми ссылками на `runtimes/opencode/*` и `shared/skills/*`;
  персональный конфиг (`opencode.json`, model-profiles) остаётся в старом
  репозитории и не мигрирует.
