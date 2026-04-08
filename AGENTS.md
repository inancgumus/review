# Review Extension

Pi extension: automated code review loop between two AI models. See [README.md](README.md) for features, install, and usage.

## Keep docs current

Update `README.md` when adding features, commands, or config options. Update `AGENTS.md` when changing dev workflow or coding patterns. Update `docs/E2E_TESTS.md` when adding test scenarios.

## Code

Eight modules in the root — split by responsibility, not by layer. `index.ts` is the entry point (state machine + commands). Other files are pure functions with no pi dependency.

No classes. No abstractions beyond plain functions and types. Keep it flat.

## Tests

**Automated** (`/tmp/review-e2e/`):
- `harness.mjs` — shared helpers (repo setup, session creation, assertions)
- `test-e2e.mjs` — behavioral scenarios using the harness

Run: `node /tmp/review-e2e/test-e2e.mjs`

Tests assert on observable outcomes (git state, model state, agent event count, file contents). Never inspect prompt internals.

**Manual** (need pi TUI): ESC/steer during reviewer or fixer, resume after reload, `/review:cfg` interactive menus. See `docs/E2E_TESTS.md`.
