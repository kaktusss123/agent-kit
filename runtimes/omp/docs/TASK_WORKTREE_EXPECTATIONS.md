# Ожидаемая модель работы с task worktrees

Этот документ задаёт верхнеуровневые ожидания для аудита спорных сессий: отличать ошибку model judgment, недостаток инструкций и дефект runtime/tooling. Здесь не описываются parser'ы или схемы инструментов.

## Task workspace и canonical worktree

Read-only анализ не создаёт task, branch или worktree. Когда начинается `/spec`, `/dev` или явная задача на изменение кода, агент устанавливает task identity и работает через managed workspace под resolved task root (задаётся generic-переменной `AGENT_TASK_ROOT`; исторический default — `~/.omp/tasks`).

Если для repository этой task уже существует canonical worktree, он является default continuation target. Secondary lane требует явной дополнительной branch need из запроса пользователя или SPEC/task decision: например backport/forward-port либо одновременно поддерживаемая release/hotfix ветка. Желание отдельно протестировать, сделать deploy, изолировать commit, попробовать другую последовательность, получить чистую ветку или обойти blocked Git operation не является такой потребностью.

Ticket нельзя придумывать. Неочевидную base branch агент тоже не угадывает.

## Primary checkout и ownership

Primary checkout — control/read-only checkout для task-generated работы. Агент может читать его, смотреть diff/status/history и выполнять безопасную диагностику, но не должен создавать там изменения задачи.

Dirty state всегда интерпретируется вместе с конкретным `path`, `gitRoot` и `classification`. Нельзя переносить вывод о dirty состоянии одного checkout на другой.

Если mutation guard заблокировал действие, это routing failure, а не разрешение повторить ту же mutation через shell, eval, Python, sed/cp или другого агента. Ручная адаптация tracked files допустима только как осознанное implementation/recovery decision, с понятной причиной и повторной проверкой diff.

Команды `rm`, `git restore`, `git clean`, `git worktree remove` и `git branch -D` не запрещены глобально: допустимость определяется ownership и состоянием target. Destructive действие над чужим или неизвестным state не выполняется по догадке.

## Multi-repo и verification

Если несколько writable repositories известны заранее, Main становится orchestrator и не реализует product changes самостоятельно. Каждый repository получает собственного owner.

Owner работает только в своём managed worktree, выполняет локальную проверку и возвращает Main результат с изменениями, проверками и gaps. Main отвечает за финальный diff/contract review и cross-repo/integration verification.

Отдельные reviewer/verifier agents используются только когда независимый контекст реально полезен, а не как обязательный этап.

## Git и внешние эффекты

Existing task branches переиспользуются без автоматического reset/rebase/merge. Commit, push, deployment и acceptance — разные состояния. Push требует явного запроса пользователя; перед external side effect проверяются только те SPEC gates/prerequisites, которые явно связаны именно с этим side effect. Открытый deploy gate блокирует push, запускающий deployment, но не обязан блокировать обычный push для draft MR; blocker должен быть назван конкретно.

Push не равен deploy, а commit не равен push. Fetch остаётся разрешённой safe refresh/control operation, необходимой для свежего branch resolution.

Raw `--no-verify` запрещён. Исключение существует только через контролируемый deferred-hook механизм после реальной ошибки hook и с проверяемыми evidence.

## Lane cleanup и критерий аудита

Lane cleanup выполняется осознанно через managed lifecycle path: canonical worktree удалить этим способом нельзя, dirty lane не удаляется, branch history автоматически не уничтожается force. Cleanup tool не является GC: нет automatic cleanup, TTL, background cleanup или persistent lane registry.

В каждый момент из task context и объективного Git state должно быть понятно:

1. какая logical task выполняется;
2. какой worktree соответствует каждому repository;
3. кто владеет изменениями каждого repository и почему;
4. какие проверки уже выполнены и какие ещё остаются.

Runtime не хранит lane owner, purpose или cleanup condition: это semantic task state из SPEC/session context, а не deterministic Git registry.

Если это невозможно восстановить, workflow считается подозрительным и требует разбора.
