# AGENTS.md

This file provides guidance to coding agents when working with code in this repository.

## What this is

`baton` is a Kanban-driven local coding agent orchestrator daemon: when a ticket is moved to a trigger lane (e.g. "In Progress") in Notion, it spins up a git worktree, runs Claude Code (or takt) headlessly to implement the ticket, opens a PR, watches CI/reviews, and moves the ticket through Notion lanes to completion. A local Bun/TypeScript re-implementation of [openai/symphony](https://github.com/openai/symphony/blob/main/SPEC.md).

`SPEC.md` is the authoritative, detailed spec (state machine, dispatch flow, PR feedback loop, needs_info escalation). Read it before making non-trivial changes to `use-cases/orchestrator.ts` or `domain/`.

## Commands

```sh
bun install                 # install deps
bun run start                # bun src/main.ts — run the daemon in the foreground
bun run once                 # bun src/main.ts --once — run a single tick
bun run dry-run               # bun src/main.ts --once --dry-run — single tick, no writes/spawns
bun run status                # bun src/main.ts status — show state.json + running processes
bun test test/                # run all tests
bun test test/domain/eligibility.test.ts   # run a single test file
bun x tsc --noEmit             # typecheck (bun run typecheck)
```

Tests never call real `ntn`/`claude`/`git`/`gh`; they exercise pure functions directly and inject a stub `CommandRunner` (the type `infrastructure/process-runner.ts` implements) for thin adapter integration tests.

Local dev runs read `config.json` in the repo root (unless `--config <path>` is given); the installed npm package instead reads `~/.config/baton/config.json`.

## Architecture

Clean Architecture, 4 layers, dependencies always point inward. Kanban provider (Notion), coding agent (Claude Code / takt), code host (GitHub), and workspace (git worktree) are all swappable Interface Adapters behind Ports.

```
src/
  domain/            pure business rules, zero external deps, no classes (except errors.ts)
  use-cases/
    ports/                KanbanPort / CodingAgentPort / CodeHostPort / WorkspacePort / StateRepositoryPort
    orchestrator.ts        thin facade wiring the runners below (shared state + tick ordering only)
    dispatch-runner.ts     claim → prepare workspace → run agent → onSuccess/onNeedsInfo/onFailure
    pr-watch-runner.ts     advancePrWatch + handling of decidePrWatchAction results (merged/ci_green/ci_rework 等)
    lifecycle-runner.ts    stopMovedOrDeletedRuns / terminalCleanup / shutdown
    startup-recovery.ts    orphan running rows → done / needs_info / retry_queued on startup
    kanban-io.ts           safe KanbanPort wrappers (safeUpdate / refreshLastEditedTime / fetchFeedbackComments)
    messages.ts            pure kanban activity / comment string builders
    prompt-builder.ts      prompt rendering (including rework/resume sections) + template file loading
    result-helpers.ts      tryAsync — Promise → Result<T,string>
  interface-adapters/
    notion/           KanbanPort impl, wraps `ntn` CLI
    claude/            CodingAgentPort impl, spawns `claude -p`
    takt/               CodingAgentPort impl, spawns `takt --pipeline`
    github/             CodeHostPort impl, wraps `gh` CLI
    git/                WorkspacePort impl, git worktree management
    persistence/         StateRepositoryPort impl, atomic JSON file (state/state.json)
  infrastructure/     config load/merge/reload+validate, logger, process-runner (spawn wrapper), launchd, format helpers
  composition.ts       DI root — wires concrete adapters into the Orchestrator based on config.provider
  main.ts               CLI entry: arg parsing, validateConfig, poll loop, signal handling
```

To add a new Kanban provider or coding agent, add a new adapter under `interface-adapters/` implementing the relevant Port, then wire it in `composition.ts` based on `config.kanban.provider` / `config.agent.provider`. The runners under `use-cases/` should not need to change for this.

`orchestrator.ts` itself is intentionally a thin composition file: shared mutable state (`state`, `active` Map, `shuttingDown` flag), Port factories bound to the current config, and the ordering of a single `tick()` cycle. All actual dispatch / PR watching / cleanup / recovery logic lives in the per-runner files above, and all state transitions go through pure builders in `domain/state.ts` (`toRunning` / `toDone` / `toNeedsInfo` / `toRetryQueued` / `toFailed` / `toDoneRecovered` / `toNeedsInfoRecovered`).

### Key domain modules (`src/domain/`)

- `ticket.ts` — `Ticket` type, Kanban-platform-agnostic
- `state.ts` — `PageStatus` / `PageState` discriminated unions (the state machine)
- `eligibility.ts` — `decideEligibility`, the pure dispatch-eligibility function
- `review.ts` — PR check normalization + `decidePrWatchAction`, the pure PR-monitoring decision function (core of the PR feedback loop)
- `workspace.ts` — slugify, branch name / worktree path generation, including the safety invariant that worktree paths must resolve inside the `workspaces/` root
- `agent-result.ts` — `AgentResult` type + zod schema for parsing the agent's `result_file` JSON
- `backoff.ts` — `computeBackoff` retry backoff calculation
- `errors.ts` — the one place classes are used, for `instanceof` narrowing

### Core flow (spread across the runners in `use-cases/`)

1. **Poll** the Kanban (Notion) for candidates matching `triggerLanes` + condition + repo set, not already running.
2. **Dispatch**: claim in state, resolve/clone repo, create a git worktree + branch, render the prompt template, spawn the agent CLI with stdin-piped prompt, write result to `state/results/<page_id>.json`.
3. **Result handling**: on success with a PR URL, state becomes `done` + `prWatch` (lane stays put, CI is watched); on success without a PR, lane moves straight to `doneLane`. On failure, retry with backoff up to `agent.maxAttempts`, then `failed`.
4. **prReconcile** (separate polling loop, `prPollIntervalMs`) drives the PR feedback loop via `decidePrWatchAction`: CI green → move to `doneLane`; CI failure → auto-rework (log injection) up to `autoReworkLimit`, then `awaitingHuman`; `CHANGES_REQUESTED` review → auto-rework; merged → move to `mergedLane`; closed → stop watching.
5. **Rework**: a human editing/moving a `done`/`failed` ticket (detected via `last_edited_time` advancing past the recorded value) triggers a fresh dispatch reusing the same worktree/branch, feeding in new page comments.
6. **needs_info**: the agent can report a question instead of failing; the ticket waits (lane untouched) until a non-bot comment or body edit answers it, then resumes in the same worktree.

### Conventions

- No classes except `domain/errors.ts` (for `instanceof` narrowing). Model state as discriminated unions, use `ts-pattern` for exhaustive matching, and `zod` only at external boundaries (Notion JSON, agent `result_file`, config).
- `infrastructure/process-runner.ts` spawns without a shell (`spawn(cmd, args)`, array-form argv) — never build shell strings, to avoid injection. Any value that ends up in argv (e.g. git branch names) must already be sanitized (see `domain/workspace.ts` slugify).
- Bun-only runtime, but avoid Bun-specific APIs (no `Bun.file`, etc.) in favor of Node built-ins (`node:child_process` spawn) — only the `bun src/main.ts` entry point itself is Bun-specific.
- `ntn`/`gh`/`git`/`claude` output parsing only reads stdout (stderr may carry warnings).
- state (`state/state.json`) is persisted with atomic writes (write to tmp, rename).
