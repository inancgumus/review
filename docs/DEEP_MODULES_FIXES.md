# Deep Modules — Remaining Fixes

What the refactor got wrong or left undone.

## 1. engine.ts is the new god file (966 lines)

Plan estimated 500-600. Reality: 966. The original plan called for a separate `manual.ts` deep module. That extraction never happened. 236 lines of manual-mode logic sit inside engine.ts:

- `detectPlannotator`, `openPlannotator`
- `pauseTimer`, `resumeTimer`
- `recoverGitState`, `advanceCommit`
- `showCommitForReview`, `startManualInnerLoop`, `afterManualInnerLoop`
- `startManual`, `initManual`, `resolveCommit`, `pickSingleCommit`
- Manual resume branch inside `resumeLoop`
- Manual approval branch inside `handleOverseerEnd`

This is the exact same problem we had with the old `index.ts` — just renamed. The Engine interface is clean (7 members), but the implementation is a monolith again. An AI changing manual mode has to read 966 lines.

**Fix:** Extract `manual.ts`. Interface: `createManualMode(engine) → { start, resume }`. Move all manual-mode functions there. engine.ts drops to ~730 lines. manual.ts is ~250 lines with 2 public methods. Both are deep.

## 2. context.ts still exists (27 lines)

Plan said absorb it. It wasn't absorbed. 27 lines with one export (`parseArgs`) imported by one consumer (`engine.ts`). This is a shallow module. Its interface IS its implementation.

**Fix:** Move `parseArgs` into engine.ts. Delete context.ts.

## 3. verdicts.ts leaks implementation (8 exports, only 3 needed)

Tests need `V_APPROVED`, `V_CHANGES`, `V_FIXES_COMPLETE`. Those are protocol constants — shared contract, correct to export.

The other 5 exports are implementation:
- `VERDICT_STRIP_RE` → only used by `log-view.ts`
- `CHANGES_STRIP_RE` → only used by `prompts.ts`
- `matchVerdict` → only used by `engine.ts`
- `hasFixesComplete` → only used by `engine.ts`
- `stripVerdict` → only used by `engine.ts`

These are not shared protocol. They're internal parsing details consumed by one module each.

**Fix:** Move `matchVerdict`, `hasFixesComplete`, `stripVerdict` into engine.ts. Move `CHANGES_STRIP_RE` into prompts.ts. Move `VERDICT_STRIP_RE` into log-view.ts. verdicts.ts shrinks to 3 constants.

## 4. types.ts exports 11 things, 5 are single-consumer

Every export is interface surface. Types that only one module uses should live in that module.

| Type | Used by |
|---|---|
| `Phase` | engine.ts only |
| `OverseerPromptParams` | prompts.ts only |
| `PromptSet` | prompts.ts only |
| `RoundResult` | log-view.ts only |
| `LoopState` | engine.ts only |
| `ReviewMode` | index.ts only |

6 types used by one consumer each. They should be colocated.

**Fix:** Move single-consumer types into their consumer modules. types.ts keeps only genuinely shared types: `LoopMode`, `ThinkingLevel`, `Config`, `Verdict`, `newState` (if still needed across modules), and any type that multiple modules actually import.

After this, types.ts has ~5 exports. Each module defines the types it owns.

## 5. Two test behaviors missing

The plan said "preserve all existing test behaviors." Two were dropped:

**a) "Manual workhorse without COMMIT prefix uses 'referenced in the feedback above'"**

The code path exists in prompts.ts (line: `"The commit under review is referenced in the feedback above."`). No test exercises it. The old `prompts-manual.test.ts` tested it directly. The integration test should trigger manual mode without a commit SHA somehow — or acknowledge this is dead code and remove it.

**b) "Manual overseer round 1 includes user feedback text"**

Round 2 test checks `assert.match(overseer2, /fix error handling/)`. Round 1 doesn't. The old test explicitly verified overseer round 1 prompt contains the user's feedback. Add the assertion to an existing manual-mode test — it's one line.

## 6. seedDemoRounds is 120 lines of hardcoded demo data inside engine.ts

`seedDemoRounds` (lines 810-919) is a 120-line function of hardcoded strings for `/loop:debug`. It's not engine logic. It's demo data. It inflates engine.ts and has nothing to do with the state machine.

**Fix:** Move to index.ts (it's a command handler concern) or a separate `demo.ts` file. Engine shouldn't carry demo data.

## Execution order

1. Add the 2 missing test assertions (one-liners, tests must pass)
2. Extract manual.ts from engine.ts (tests pass — they don't import engine.ts)
3. Absorb context.ts into engine.ts (delete context.ts)
4. Move single-consumer types from types.ts into their modules
5. Move single-consumer verdicts exports into their consumers
6. Move seedDemoRounds out of engine.ts

After all fixes:

```
index.ts       ~180 lines   — command router + demo data
engine.ts      ~600 lines   — loop state machine (2 exports)
manual.ts      ~250 lines   — manual review mode (2 exports)
git.ts         ~270 lines   — git operations (2 exports)
prompts.ts     ~510 lines   — prompt building (3 exports)
log-view.ts    ~600 lines   — TUI log viewer (3 exports)
config.ts       ~64 lines   — settings persistence (4 exports)
types.ts        ~50 lines   — shared types only (~5 exports)
verdicts.ts     ~10 lines   — 3 protocol constants
diff-review.ts ~159 lines   — editor-based annotation (1 export)
```

Every module deep. No shallow survivors. No god files.
