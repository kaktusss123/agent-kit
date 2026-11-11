# Участие в разработке

Раскладка репозитория и есть желаемое состояние установки: манифестов и
списков нет. Для нового навыка создайте каталог в `skills/` с `SKILL.md`:
`name` должен совпадать с именем каталога, `description` обязателен.
Для нового расширения Pi создайте каталог в `extensions/`.
После добавления выполните `agent-kit install`.

Тесты:

```sh
tests/installer/run.sh          # isolated HOME; add -v for installer output
tests/layout/run.sh             # repository layout invariants
tests/skills/run.sh             # frontmatter, references, skill:// links
node --test tests/codex/*.test.mjs # isolated install, hooks, discovery without a model
tests/snapshot/run.sh           # atomicity, locking, retention, manifest validation,
                                # dirty-checkout refusal, SIGKILL, concurrency
node --test --test-timeout=180000 'extensions/**/*.test.ts'
```

Для одного расширения замените `<name>` его именем:

```sh
node --test --test-timeout=180000 'extensions/<name>/*.test.ts'
```

Тестам расширений нужны пакеты Pi в `node_modules/` (gitignored): симлинки
`@earendil-works/pi-coding-agent`, `pi-ai`, `pi-tui` и `typebox` на
установленный Pi. В managed worktree runtime создаёт их сам. Если установка
Pi или её снимок неполны, ссылки не заменяют установку зависимостей. Для
изолированной проверки можно установить согласованную версию в игнорируемый
`node_modules/.pi-test-runtime` (версию взять из `pi --version`, не из старого
снимка), не меняя установленный Pi:

```sh
npm install --prefix "$PWD/node_modules/.pi-test-runtime" \
  --cache "$PWD/node_modules/.npm-cache" --no-save --package-lock=false \
  --no-audit --no-fund @earendil-works/pi-coding-agent@1.5.0
mkdir -p node_modules/@earendil-works
# Remove only existing bootstrap symlinks at these exact destinations first;
# do not delete their targets or replace real package directories.
for pkg in pi-coding-agent pi-ai pi-tui; do
  ln -s "../.pi-test-runtime/node_modules/@earendil-works/$pkg" "node_modules/@earendil-works/$pkg"
done
ln -s .pi-test-runtime/node_modules/typebox node_modules/typebox
ln -s .pi-test-runtime/node_modules/jiti node_modules/jiti
```

Версия `1.5.0` приведена как проверенный пример, а не требование обновлять Pi.
Собственные зависимости Pi фиксируют совместимые версии SDK, `chalk`, `jiti`
и `typebox`.
Контрактная проверка настоящего загрузчика и изолированного RPC без запросов
к модели: `node --test extensions/subagents/read-only-state-loader.test.ts`.
Она не пропускается при отсутствующих пакетах. Для полной изоляции остальных
тестов задайте отдельные `HOME`, `TMPDIR` и `PI_AGENT_DIR`. CLI-тесты создают
собственные репозитории под `$HOME/.cache`: фактический `HOME` не должен быть
под `/tmp`, где guard намеренно разрешает изменения. `TMPDIR`, напротив,
должен быть вне любого Git-дерева, иначе проверки обнаружения Git увидят
родительский checkout. Для полного набора нужен короткий физический путь
`HOME` (например, свежий `mktemp -d /var/tmp/ak-home-XXXXXX`): длинный путь
изменяет проверяемое усечение, а симлинк не подходит проверкам `realpath`.
Удаляйте только созданные проверкой временные каталоги.

Дополнительная проверка согласованной передачи с отдельно подготовленной
корпоративной поставкой:

```sh
AGENT_KIT_CLOUDRU_REPO=/path/to/verified/corporate-checkout \
  tests/installer/handoff-chain.sh
```

Она читает закоммиченные деревья: реальный старый Core, текущий `HEAD` Core и
`HEAD` явно указанной поставки. Установка, передача и настоящий старый
`update` с pull выполняются только в одноразовом `HOME` с локальным Git remote.
Проверяются отрицательный контроль без передачи и независимое удаление обоих
продуктов. Это проверка на временных установках, не миграция рабочей машины;
корпоративное содержимое в Core не копируется. Обычные проверки Core не требуют
корпоративного checkout или сети.

Live-проверки в
`extensions/*/live/` запускают настоящий `pi` и в обычный прогон не входят.
