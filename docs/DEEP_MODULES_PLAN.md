# Deep Modules Plan

## Run tests

`npx tsx --test --test-timeout=15000 tests/*.test.ts`

All tests must pass after every step. No exceptions.

## Architecture principles

See AGENTS.md for dev workflow. Read ~/.agents/docs/goodarchitecture.md for the full rationale. Always manually test changes with pi — run /loop, /loop:exec, /loop:manual against a real repo.

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

## Resolved violations

All 7 violations identified during design have been fixed:

1. ~~context.ts returns markdown~~ → readContextPaths returns raw {path, content}[]. expandContextPaths removed. formatContextMarkdown is an opt-in helper callers invoke when they want the prompt block.
2. ~~index.ts reaches into mode state~~ → modes expose isRunning(), getMaxRounds(), setMaxRounds(), logSnapshot(). isOverseerTurn() removed — tool blocking moved to session.ts.
3. ~~session.ts EDITOR_BLOCK says "review loop"~~ → says "blocked during loop".
4. ~~mode-specific terms in infrastructure comments~~ → rewritten to generic terms.
5. ~~manual.ts uses pi.events for plannotator~~ → plannotator wiring lives in index.ts, the single boundary with other extensions. Modes don't touch pi.events.
6. ~~index.ts re-exports loadPiAgent~~ → removed.
7. ~~modes receive pi (ExtensionAPI) directly~~ → only index.ts and session.ts reference pi. All model switching, thinking-level changes, and message sending go through session.ts.

## Done

### Phase 1: Convert unit tests to integration tests ✅

All 7 unit test files converted. log-view.test.ts imports from index.ts now. Gate passed: `grep -r "from \"\.\.\/" tests/ | grep -v index.ts | grep -v verdicts.ts` returns nothing.

### Phase 2: Each mode owns its loop ✅

All 16 steps complete. engine.ts and prompts.ts deleted. 123 tests pass.

#### Current file structure

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

#### Bugs fixed (post-refactor)

1. status.stop() before status.elapsed() → elapsed always 0. Fix: cleanup() reads elapsed before stop.
2. stop() no-op when loopPromise is null (start crashed mid-setup). Fix: start/resume wrap setup in try/catch that calls cleanup. stop() never bails on phase===idle.
3. Ghost timers from hot reload. Fix: status.ts tracks intervals in globalThis, killGhostTimers() in index.ts clears them on every load.
4. Phase state machine (`idle`|`reviewing`|`fixing`) in all modes violated "no event-driven architecture." Fix: replaced with `running: boolean`. Tool blocking moved from index.ts to session.ts via blockTools()/unblockTools(). Modes call these directly — no phase variable needed. isOverseerTurn() removed from Mode interface.
