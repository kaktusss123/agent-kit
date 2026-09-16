# Design progress

Навигационный индекс архитектурных этапов. Это не спецификация и не второй
набор ADR: содержание решений живёт в ADR и документации capabilities;
здесь только что решалось, чем закончилось и где искать.

| Stage | Status | Result |
| --- | --- | --- |
| A1 | Done | Pi-first boundary: agent-kit — самостоятельный локальный framework для Pi; multi-harness abstraction и control-plane зависимости отклонены; Task/Run/Pi Session разделены концептуально. [ADR-0001](adr/adr-0001.md). |
| A2 | Done | Candidate commit — граница финальной верификации: commit SHA как immutable identifier проверяемого состояния, без workflow state machine и evidence store. [ADR-0002](adr/adr-0002.md). |
| A3 | Done | Runtime-проверка settled состояния при `done` (чистое дерево и HEAD после остановки child) и объективные `git_facts` в терминальном результате. [ADR-0003](adr/adr-0003.md); реализация — workspace run layer в [`../extensions/subagents/workspace-runs.ts`](../extensions/subagents/workspace-runs.ts). |
| A4 | Done | Единая поверхность субагентов: `workspace_agent` слит в `subagent` как workspace spawn mode; RepoOwner protocol задокументирован в [`../skills/git-task/references/repo-owners.md`](../skills/git-task/references/repo-owners.md). Без отдельного ADR: решение отражено примечанием в ADR-0003 и реализацией (PR #13, #20). |
| A5 | Done | Crash recovery без durable Run: смерть Main → EOF завершает RepoOwner; восстановление = Pi session resume + новый RepoOwner по состоянию Git/worktree/artifacts. [ADR-0004](adr/adr-0004.md). |
| A6 | Done | Headless Pi: штатный `pi --mode rpc` покрывает запуск, управление, `ask`, отмену, наблюдение и восстановление Main-сессии; RepoOwner работает без изменений. Новый runtime, daemon, event journal или RPC-протокол не введены. [ADR-0005](adr/adr-0005.md). |
| A7 | Done | Research удалённого управления: T3 Code и Orca как референсы. Берём выполнение на рабочей машине, disconnect/reconnect, стабильную machine identity, pairing/revocation доступа; отвергаем event store, projections, provider abstraction, command journal — durable state остаётся в Pi sessions, Git/worktrees и agent-kit artifacts. Граница: Browser → control plane → agent node → `pi --mode rpc` → agent-kit. [research](research/a7-remote-control-research.md). |

Next: A8 — минимальный vertical slice удалённого управления

> A8 доказывает end-to-end путь client → control plane → agent node → `pi --mode rpc` → agent-kit в минимально достаточной форме. Это не платформа: протокол, API, pairing, UI заранее не проектируются; slice расширяется только после доказанного сквозного пути.
