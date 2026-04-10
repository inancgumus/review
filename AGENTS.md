# Loop Extension

Two-model loop for pi. See [README.md](README.md) for install, usage, and features.

## Docs

Update `README.md` when you change features, commands, or config. Update this file when you change dev workflow. Update `docs/E2E_TESTS.md` when you add test scenarios.

## Code

Modules split by responsibility. `index.ts` is the entry point (state machine + commands). Other files export pure functions.

No classes. Plain functions and types. Keep it flat.

## Tests

**Automated** (`/tmp/loop-e2e/`): `harness.mjs` (shared helpers) + `test-e2e.mjs` (scenarios). Run: `node /tmp/loop-e2e/test-e2e.mjs`. Assert on observable outcomes (git state, model state, event count, file contents). Never inspect prompt internals.

**Manual** (TUI only): ESC/steer, resume after reload, `/loop:cfg` menus. See `docs/E2E_TESTS.md`.
