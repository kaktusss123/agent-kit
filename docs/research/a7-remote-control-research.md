# A7: research слоя удалённого управления (T3 Code, Orca)

Status: research завершён
Date: 2026-09-16

## Purpose and scope

A7 — исследовательский этап перед проектированием удалённого управления поверх
уже доказанной границы `pi --mode rpc` (ADR-0005). Изучались две готовые
системы как архитектурные референсы:

* **T3 Code** (`pingdotgg/t3code`) — control surface для coding agents
  с web/desktop/mobile клиентами, event-sourced оркестрацией и pairing'ом
  удалённого доступа (T3 Connect);
* **Orca** (`stablyai/orca`) — agent development environment, где выполнение
  агентов живёт на remote/work-машине: SSH-хосты, worktrees, терминалы
  с reconnect'ом, pairing устройств.

Вопрос A7: какие понятия из этих систем подходят слою над `pi --mode rpc`,
а какие противоречат уже принятым решениям (ADR-0001, ADR-0004, ADR-0005).

Scope — выводы уровня архитектурной границы. Протоколы, API, схемы, UI здесь
не проектируются; это вопросы следующих этапов, начиная с A8.

## Что уже закрыто и не переоткрывается

Рабочие заметки ранних стадий содержали утверждения, которые current `main`
уже сделал устаревшими:

* **Durable Run** — закрыт ADR-0004: отдельный Run runtime сознательно не
  вводится, восстановление опирается на Pi session resume + Git/worktree +
  task artifacts;
* **Headless execution** — закрыт ADR-0005: штатный `pi --mode rpc`;
* **`/proxy`** — машинная proxy-preference уже реализована в текущем
  agent-kit (расширение `proxy-toggle`, см. README; передача preference
  subagent-детям — PR #30) и не является блокером удалённого управления;
* решения A1–A4 не пересматриваются.

## T3 Code

T3 Code оказался полезен как источник идей, но не как целевая сетевая
архитектура.

### Что берём

* агент-процесс принадлежит рабочей машине, а не браузеру;
* disconnect браузера не означает завершение агента;
* наблюдение, к которому можно переподключиться (reconnectable observation),
  полезно и для нашего node;
* неоднозначные мутации не слепо реплеятся после reconnect — нужно явное
  правило, что происходит с операциями, результат которых неизвестен;
* identity машины должна быть стабильной и независимой от hostname, IP
  и tunnel endpoint.

### Что не копируем

* event store / event sourcing;
* центральные projections как второй source of truth;
* provider abstraction (перекладывание на несколько agent runtime'ов);
* provider-specific resume/recovery machinery;
* топологию T3 Connect;
* generic command journal и durable command receipts;
* provider-specific interrupt/recovery механизмы.

Обоснование: наш durable state уже существует — Pi sessions, Git/worktrees
и agent-kit artifacts (ADR-0004, ADR-0005). Event store с projections создал
бы второй source of truth, который ADR-0001 (§1, §6) прямо запрещает:
control plane не становится владельцем canonical state.

## Orca

Orca — более близкий архитектурный референс для границы удалённого
управления, потому что он решает ту же задачу: клиент на другом устройстве
работает с агентами, живущими на удалённой машине.

### Что берём

* выполнение остаётся на remote/work-машине;
* удалённый хост владеет projects, worktrees и agent sessions;
* headless-работа хоста — первоклассный режим, а не деградация;
* клиенты могут отключаться и переподключаться, не владея выполнением;
* доступ клиентов/устройств подключается (pairing) и отзывается
  индивидуально.

### Что не копируем

Orca не копируется как продукт или runtime. В частности, не импортируются:

* его IDE и редактор;
* терминал и terminal lease/relay machinery;
* worktree engine;
* provider abstraction;
* SSH relay;
* editor/browser-функциональность;
* прочие механизмы, которые agent-kit уже имеет или не нуждается в них.

## USE / ADAPT / REJECT

| Категория | Что именно |
| --- | --- |
| USE | выполнение на рабочей машине; disconnect ≠ смерть агента; reconnectable observation; запрет слепого replay неоднозначных мутаций; стабильная machine identity; pairing/revocation доступа клиентов как понятие control plane |
| ADAPT | headless-хост как первоклассный режим → в наших терминах: node управляет headless `pi --mode rpc` и ничем больше; внешний слой показывает публичные user-facing понятия agent-kit (task, worktree, RepoOwner), не переопределяя их внутреннюю семантику |
| REJECT | event store и event sourcing; центральные projections; provider abstraction; provider-specific resume/recovery и interrupt/recovery; T3 Connect topology; generic command journal; durable command receipts; SSH relay; IDE/terminal/editor machinery Orca |

## Итоговая граница

Целевое направление не меняется (ADR-0001 §10):

```text
Browser
   |
Control plane
   |
Agent node
   |
pi --mode rpc
   |
agent-kit
```

Правила владения:

* `agent-kit` остаётся полностью пригодным без node и control plane
  (ADR-0001 §1);
* Pi владеет Pi sessions и семантикой своего RPC;
* `agent-kit` владеет skills, prompts, subagents, task/worktree семантикой,
  Git policy, verification и локальными artifacts;
* будущий node владеет только живым локальным Pi-процессом и транспортом;
* будущий control plane координирует доступ, но не становится source of
  truth для Pi sessions, tasks, subagents или worktrees;
* внешний слой может показывать публичные user-facing понятия agent-kit,
  но не должен переимплементировать их внутреннюю семантику.

## Non-goals

Из этого исследования не следует и в ближайших этапах не проектируется:

* agent-node как продукт;
* control-plane API;
* WebSocket-протокол;
* схема БД;
* event journal;
* durable command receipts;
* capability registry;
* generic action descriptors;
* scheduler;
* интеграция с task tracker;
* Git background fetch;
* repository update UX;
* self-update;
* structured subagent read API;
* аутентификация;
* device pairing (механика);
* web UI.

Общие абстракции «на будущее» не вводятся.

## Что A7 решает и что не решает

Решает:

* направление границы и правила владения между agent-kit, Pi, node
  и control plane;
* что берётся из T3 Code и Orca, а что отвергается и почему;
* что следующий этап — A8, минимальный vertical slice удалённого
  управления: доказать end-to-end путь, а не строить платформу.

Не решает:

* транспорт и протокол node ↔ control plane;
* форму control-plane API и хранение его состояния;
* аутентификацию и механику pairing/revocation;
* где живут код node и control plane (отдельный репозиторий ожидаем, но
  это отдельное решение);
* что именно входит в A8 slice — это определяется при планировании A8.

## References

* T3 Code — <https://github.com/pingdotgg/t3code>; конкретная ревизия в
  durable-артефактах задачи не зафиксирована.
* Orca — <https://github.com/stablyai/orca>; конкретная ревизия не
  зафиксирована и сознательно не выдумывается.
* [ADR-0001](../adr/adr-0001.md) — §1 (standalone framework), §5 (Task/Run/
  Pi Session), §8 (telemetry ≠ control), §9 (headless в agent-kit),
  §10 (remote management как внешний слой).
* [ADR-0004](../adr/adr-0004.md) — crash recovery без durable Run.
* [ADR-0005](../adr/adr-0005.md) — headless на штатном `pi --mode rpc`.
* [design-progress.md](../design-progress.md) — индекс этапов.
