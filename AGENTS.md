# Loop Extension

Three-mode loop for pi: review, exec, and manual. See [README.md](README.md) for install, usage, and features.

## Docs

Update `README.md` when you change features, commands, or config. Update this file when you change dev workflow. Update `docs/E2E_TESTS.md` when you add test scenarios.

## Code

Modules split by responsibility:

- `index.ts` — entry point, state machine, commands, event handlers
- `types.ts` — all types, `LoopState`, `newState()`
- `config.ts` — settings load/save from `~/.pi/agent/settings.json`
- `prompts.ts` / `prompts-review.ts` / `prompts-exec.ts` / `prompts-manual.ts` — per-mode prompt builders
- `diff-review.ts` — editor-based diff annotation (opens `$EDITOR`, parses comments back with file:line refs)
- `git-manual.ts` — git helpers for manual mode (commit list, patch-id, range resolution, state recovery)
- `fixup-audit.ts` — patch-id tracking for review mode
- `verdicts.ts` — verdict parsing (APPROVED / CHANGES_REQUESTED / FIXES_COMPLETE)
- `session.ts` — session utilities (sanitize, model helpers)
- `reconstruct.ts` — state reconstruction for `/loop:resume`
- `log-view.ts` — TUI log viewer (`/loop:log`)
- `tui-runtime.ts` — pi TUI module loader

No classes. Plain functions and types. Keep it flat.

## Manual mode specifics

- Single commit at a time. No multi-commit range.
- `$EDITOR` annotation: diff opens in editor, user types comments inline, parser extracts `sha:file:line` feedback.
- Plannotator integration: when enabled, delegates commit selection + annotation to the browser.
- No git state mangling (no detached HEAD). Git state recovery on broken rebase/detached HEAD.
- All `log()` calls suppressed — no `[loop-log]` boxes in chat. Round data in `/loop:log`.
- Timer only counts inner loop (workhorse/overseer) time.

## Tests

Run all: `npx tsx --test tests/*.test.ts`

Unit tests per module. Manual mode tests use a mock review function injected via `pi.events.emit("loop:set-review-fn", fn)`. Test harness creates temp git repos for git-dependent tests.

**Manual** (TUI only): ESC/steer, resume after reload, `/loop:cfg` menus. See `docs/E2E_TESTS.md`.
