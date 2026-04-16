pi extension. See README.md for user docs.

Architecture: read docs/DEEP_MODULES_PLAN.md and ~/Desktop/goodarchitecture.md before touching anything.

Run tests: `npx tsx --test --test-timeout=15000 tests/*.test.ts`
TDD only. Write a failing test first, see it fail, then fix. No exceptions.
Integration tests only — import index.ts and verdicts.ts, never internal modules.
Do not consider yourself done without manually testing changes with pi — run /loop, /loop:exec, /loop:manual against a real repo and verify the behavior.

Modules:
- index.ts — entry point. Creates session+status+modes, registers commands, routes input. No logic beyond routing.
- review-fresh.ts, review-incremental.ts, exec.ts, manual.ts — modes. Each owns its full loop top-to-bottom as a while loop with await. Modes never import each other.
- session.ts — wraps pi's event model into setModel()+send()→Promise. Absorbs agent_end into promises. Modes never see events.
- status.ts — timer (start/stop/pause/elapsed/formatDuration). Tracks intervals via globalThis for ghost timer cleanup on hot reload. Modes own their status bar text.
- verdicts.ts — wire protocol constants and parsing. matchVerdict, hasFixesComplete, sanitize.
- context.ts — parses `@path` args (e.g. `/loop fix auth @src/login.ts`), reads files/dirs at those paths, hashes content for change detection. Returns raw data, modes format for prompts.
- config.ts — settings persistence (loadConfig, saveConfigField).
- git.ts — git operations (resolveRange, checkGitState, snapshotPatchIds). No mode knowledge.
- review-workhorse.ts — shared review fix prompt + reconstructState. Used by both review modes.
- diff-review.ts — editor-based commit annotation. Used by manual mode.
- log-view.ts — TUI log viewer for /loop:log.

Dependencies flow downward only: modes → infrastructure → nothing. Infrastructure never imports modes.
Infrastructure is generic — no mode-specific terms, formatting, or decisions. Treat every module as someone else's API you can't change.
Timers: use trackInterval/untrackInterval from status.ts. killGhostTimers() in index.ts clears them on reload.
Cancellation: session.stop() rejects pending promise with StopError. Modes catch it in try/catch and run cleanup.
Cleanup: every mode has cleanup() that reads elapsed before stopping the timer. start() and resume() wrap setup in try/catch that calls cleanup on failure. state.phase="idle" is set after model restore completes.
