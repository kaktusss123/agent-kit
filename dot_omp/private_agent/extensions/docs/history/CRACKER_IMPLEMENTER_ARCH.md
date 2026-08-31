# Cracker/Implementer Workflow Architecture — V2

## Overview

Two-role development lifecycle with runtime-enforced write boundaries,
immutable approval snapshots, and deterministic verification gates:

ENGINEER → GROK (cracker) → APPROVAL (user) → IMPLEMENT (implementer) → VERIFIED DIFF

## Task Runtime

**Source:** `dot_omp/private_agent/extensions/task-runtime/`
**Runtime:** `~/.omp/agent/extensions/task-runtime/`
**Loaded by:** OMP via `package.json#omp.extensions: ["./index.ts"]`

### State machine

    discovery → ready_for_approval → approved → implementing → completed
         ↑            ↓                ↓            ↓
         └── discovery ← blocked ← blocked ← task_block (spec conflict)

completed and failed are terminal (no outgoing transitions).

### Manifest (V2)

    schemaVersion: 2
    id: "EVODP-12345"
    phase: "implementing"
    primaryRepo: "trino-instance"
    repos: { primary/target/reference with sourcePath, worktreePath, baseSha }
    sessions: { cracker: {...}, implementer: {...} }  ← role is explicit
    approval: { id, snapshotPath, specSha256 }

Key invariants: sourcePath never equals worktreePath; primaryRepo is a key; session role explicit, not cwd-inferred.

### Storage layout

    ~/.omp/tasks/<id>/manifest.json, events.jsonl, artifacts/, snapshots/<approval>/, worktrees/<repo>/

## Commands

    /task_init          create V2 task, bind cracker session
    /task_add_repo      attach target/reference (adapter over task_attach_repo tool)
    /task_status        structured status
    /task_approve       readiness validation → freeze snapshot → prepare worktrees
    /task_handoff       newSession → moveTo(worktree) → addWorkspaceDirectory(targets) → '/Users/komar/.omp/agent/skills/implementer'
    /task_reopen        return approved/implementing/blocked → discovery

## Model tools

    task_status          any bound   structured status
    task_attach_repo     cracker    register repos
    task_write_artifact  cracker    write spec/evidence
    task_record_decision cracker    open/resolve decisions
    task_set_verification cracker   define verification contract
    task_mark_ready      cracker    run readiness validation
    task_block           implementer signal spec conflict
    task_submit          implementer verification + completion gate

## Write policy

pi.on("tool_call") pre-guard: edit/write blocked outside role-writable roots.
pi.on("tool_result") bash guard: fingerprints before/after, rollback on protected-repo mutation.
Session-based manifest lookup (not cwd).

    cracker:   writable ~/.omp/tasks/<id>/artifacts/ only; all repos read-only.
    implementer: writable primary/target worktrees only; source/ref/snapshot read-only.

## Skills

    '/Users/komar/.omp/agent/skills/cracker'     fact/decision separation, frontier questions, task_mark_ready
    '/Users/komar/.omp/agent/skills/implementer' read handoff.json, implement, task_submit, task_block on conflict

Both invoked via skill:// URIs in the agent bootstrap message.

## Verification

    task_submit → snapshot valid? → protected repos unchanged? → non-empty diff? → run checks → completed
