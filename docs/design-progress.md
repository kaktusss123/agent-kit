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
| A6 | Next | Headless Pi. |

Next: A6 — headless Pi

> A6 должен исследовать минимальный способ управлять обычной Pi-сессией без TUI; не следует заранее вводить durable Run runtime, daemon или control-plane abstractions.
