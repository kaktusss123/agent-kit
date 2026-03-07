---
description: Run the complete testing pipeline
---

# Testing Pipeline

This command runs the complete testing pipeline for the project.

## Usage

To run the complete testing pipeline, just type:

1. Run pnpm type:check
2. Run pnpm lint
3. Run pnpm test
4. Report any failures and stop
5. Report success if all steps pass

## What This Command Does

1. Runs `pnpm type:check` to check for type errors
2. Runs `pnpm lint` to check for linting errors
3. Runs `pnpm test` to run the tests
4. Reports any failures
