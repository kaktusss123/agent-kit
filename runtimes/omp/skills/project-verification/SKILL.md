---
name: project-verification
description: "Create or maintain a project-local way for agents to launch, health-check, drive, observe, and clean up the real application or service. Use when a repository lacks a reliable scripted verification path and future agents repeatedly have to rediscover how to prove CLI, API, UI, service, or integration behavior."
---

# Project verification

Create a reusable project capability, not a one-off test transcript.

## Interview the repository

Determine from code and docs:
- **Surface**: what users or integrations actually touch;
- **Launch**: canonical local start/build command and readiness signal;
- **Doctor**: read-only health/version/config check;
- **Drive**: stable programmatic way to exercise the real path;
- **Evidence**: outputs that prove action and resulting state;
- **Isolation**: ports, profiles, data dirs, or limitations on parallel instances;
- **Cleanup**: how to stop only what the verification run started.

Prefer existing project harnesses. Do not invent a second testing stack when Playwright, pytest, an integration CLI, curl scripts, or similar already solve the problem.

## Write project-local guidance

Store it where the repository keeps agent/project guidance. Keep environment-specific secrets and personal paths out of shared files.

A good capability names exact commands/selectors/endpoints and the evidence expected from them.

## Prove the capability

Run one representative end-to-end path using the written instructions. Confirm cleanup does not destroy the evidence. A verification guide that has never been executed is a draft.

Task Runtime may consume this capability when choosing task-specific gates, but the project capability must remain useful outside Task Runtime too.
