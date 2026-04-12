# Loop Extension

Three-mode loop for pi. See [README.md](README.md) for install, usage, and features.

## Docs

Update `README.md` when you change features, commands, or config. Update this file when you change dev workflow. Update `docs/E2E_TESTS.md` when you add test scenarios.

## Code

Modules split by responsibility. `index.ts` is the entry point (state machine + commands). Other files export pure functions.

No classes. Plain functions and types. Keep it flat.

Manual mode suppresses all `log()` calls — no `[loop-log]` entries in chat. Round data only in `/loop:log`. Test the review function via `pi.events.emit("loop:set-review-fn", fn)`.

## Tests

Run all: `npx tsx --test tests/*.test.ts`

**Manual** (TUI only): ESC/steer, resume after reload, `/loop:cfg` menus. See `docs/E2E_TESTS.md`.
