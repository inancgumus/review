# Deep Modules Plan

## Run tests

`npx tsx --test --test-timeout=15000 tests/*.test.ts`

All tests must pass after every step. No exceptions.

## Architecture principles

Read ~/Desktop/goodarchitecture.md for the full rationale.

- Deep modules: change one module, nothing else changes.
- Each mode owns its loop top-to-bottom as a while loop with await. No shared cycle. No ModeConfig.
- Session wraps pi's event model into setModel()+send()→Promise<{ text: string }>. Modes never see agent_end.
- Infrastructure is generic: no mode-specific terms, formatting, or decisions. Treat as third-party API.
- Infrastructure survives feature churn: add a mode — helpers don't change. Remove a mode — helpers don't change.
- Callers decide, helpers execute: return raw data, let modes format and interpret.
- Dependencies flow downward: modes → infrastructure → nothing. Modes never import each other.
- Cancellation via StopError rejection. Modes catch in try/catch, run cleanup.
- Integration tests only. Import index.ts and verdicts.ts, never internal modules.
- send() returns { text: string } not bare string — future metadata is additive with zero ripple.

## Current state

All 16 original steps are complete. engine.ts and prompts.ts are deleted. 123 tests pass.

### File structure

```
index.ts              — Entry point. Creates session+status+modes, registers commands, routes input.
review-fresh.ts       — Fresh review loop. Full re-review each round.
review-incremental.ts — Incremental review loop. Patch-id audit, context tracking.
review-workhorse.ts   — Shared review fix prompt + reconstructState.
exec.ts               — Exec loop. Step-by-step plan execution.
manual.ts             — Manual review. Editor/plannotator, commit flow.
session.ts            — Pi session. setModel, send, navigate, anchors, editors. Zero mode knowledge.
verdicts.ts           — Wire protocol. Constants, parsing, sanitize.
context.ts            — File I/O. @path parsing, reading, hashing.
status.ts             — Timer + formatDuration. Ghost timer cleanup via globalThis.
git.ts                — Git operations + patch-id lifecycle.
config.ts             — Settings persistence.
diff-review.ts        — Editor-based commit annotation.
log-view.ts           — TUI log viewer.
types.ts              — Shared type aliases.
demo.ts               — Debug data for /loop:debug.
```

### Bugs fixed (post-refactor)

1. status.stop() before status.elapsed() → elapsed always 0. Fix: cleanup() reads elapsed before stop.
2. stop() no-op when loopPromise is null (start crashed mid-setup). Fix: start/resume wrap setup in try/catch that calls cleanup. stop() never bails on phase===idle.
3. Ghost timers from hot reload. Fix: status.ts tracks intervals in globalThis, killGhostTimers() in index.ts clears them on every load.

## Remaining violations

These diverge from the architecture principles. Each needs a failing test first, then a fix.

### 1. context.ts returns markdown, not raw data

expandContextPaths() returns `## Context files\n### path\n```content``` `. readContextPaths() exists and returns raw {path, content}[] but no caller uses it. All callers use expandContextPaths and get pre-formatted markdown.

Principle violated: callers decide, helpers execute.

Fix: callers switch from expandContextPaths to readContextPaths + their own formatting. Delete expandContextPaths or make it a convenience wrapper that callers opt into.

### 2. index.ts reaches into mode state

index.ts reads mode.state.phase, state.round, state.maxRounds, state.roundResults, state.loopStartedAt for:
- activeMode() — finds running mode via `state.phase !== "idle"`
- tool_call hook — blocks edit/write when `state.phase === "reviewing"`
- /loop:rounds — reads/writes state.maxRounds
- /loop:log — reads state.initialRequest, roundResults, loopStartedAt

Principle violated: modules as third-party APIs (index.ts knows mode internals).

Fix: modes expose narrow methods instead of raw state:
- mode.isRunning(): boolean
- mode.isOverseerTurn(): boolean  
- mode.setMaxRounds(n): void
- mode.logData(): { request, results, startedAt }

### 3. Modes receive pi (ExtensionAPI) directly

All 4 modes take `pi: ExtensionAPI` as first arg and call pi.setModel, pi.setThinkingLevel, pi.getThinkingLevel, pi.sendMessage directly — bypassing session.ts.

Principle violated: session.ts is the only pi interaction layer.

Fix: add missing methods to session.ts (getThinkingLevel, setThinkingLevel, sendCustomMessage). Modes stop importing pi. Only session.ts and index.ts touch pi directly.

### 4. manual.ts uses pi.events for plannotator

manual.ts uses pi.events.on("loop:set-review-fn") and pi.events.emit("plannotator:request") for cross-extension communication. This is event-driven architecture.

Principle violated: no event-driven architecture.

Fix: needs investigation. The plannotator is a separate extension that manual.ts coordinates with. Events might be the only option for cross-extension communication in pi. If so, document it as a boundary exception, not a pattern to follow internally.
