# Deep Fixes — Merge Notes

The deep-modules branch has bug fixes and features interleaved with structural refactoring. When integrating fixes 7 and 8 from `DEEP_MODULES_FIXES.md`, these changes must be carried forward. Check git log for exact commits.

## Overseer tool blocking

The overseer prompt says "do not edit or write files" but nothing enforced it. Models ignored the instruction and called edit/write anyway. Now a `tool_call` handler blocks edit/write during the reviewing phase and returns a nudge to use read/bash only. Lives in index.ts as a `pi.on("tool_call")` handler that checks `engine.state.phase`.

## Exec mode plan leaking

The workhorse saw the overseer's full response in exec mode. If the overseer mentioned future steps (which models do despite instructions), the workhorse implemented ahead and broke the drip-feed. Now the overseer wraps the current step in `<task>` tags. The exec workhorse prompt builder strips everything outside the tags. If no tags found, falls back to full text. Lives in prompts.ts exec workhorse builder.

## Manual mode cwd resolution

pi sets `ctx.cwd` to `~` when launched with a path argument. Review and exec modes work because the agent runs git itself. Manual mode runs `execSync` with `ctx.cwd` directly, so every git command failed. `gitToplevel()` in git.ts resolves the actual git root by trying ctx.cwd, process.cwd(), then the first user message. Both `manual.start()` and `manual.resume()` call it before any git operations. The resolved cwd is also stored in the anchor so resume doesn't lose it.

## Plannotator path guards

Three bugs in the plannotator code path, all related to plannotator manual mode having no commitList (unlike editor-based manual mode):

1. `startManualInnerLoop` built `[COMMIT:sha]` blindly — produced `commit undefined` in prompts when commitList was empty. Now guards the SHA.

2. Resume checked `Array.isArray(commitList)` but not `length > 0`. Empty array entered the commit-review resume path, showed "commit 1/0", silently stopped. Now requires non-empty.

3. Resume called `openPlannotator()` without checking `detectPlannotator()` first. If the plannotator extension wasn't loaded, the promise never resolved and the session hung forever. Now checks availability and notifies the user.

## Test additions

New integration tests covering: tool blocking during review phase, exec mode task tag extraction and fallback, plannotator COMMIT:undefined guard, empty commitList resume guard, plannotator resume with/without handler, cwd resolution on resume, overseer round 1 user feedback assertion.
