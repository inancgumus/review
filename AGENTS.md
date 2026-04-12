# Loop Extension

Three-mode loop for pi. See [README.md](README.md) for install, usage, and features.

## Docs

Update `README.md` when you change features, commands, or config. Update this file when you change dev workflow. Update `docs/E2E_TESTS.md` when you add test scenarios.

## Code

Modules split by responsibility. `index.ts` is the entry point (state machine + commands). Other files export pure functions. No classes. Plain functions and types. Keep it flat.

## Tests

Run all: `npx tsx --test tests/*.test.ts`

Always apply TDD. We never test with unit tests. We only do high-level
integration tests through our testing API. Besides automated testing, also
manually test your changes with agent-tui and pi (no shortcuts). See 
@docs/E2E_TESTS.md for manual testing.
