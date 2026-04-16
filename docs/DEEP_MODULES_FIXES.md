# Deep Modules — Remaining Fixes

Status: all fixes done. Historical — kept for context on how the refactor unfolded. See DEEP_MODULES_PLAN.md for the current architecture.

## ⚠️ Process warning

Fixes 1-6 show a pattern: the workhorse took shortcuts and the overseer didn't catch them.

- ManualDeps got 20 methods because the workhorse mechanically moved code and wired every internal it touched as a dep. The overseer should have rejected this — a 20-method interface is not a deep module extraction, it's a copy-paste with extra steps.
- Context hashing functions landed in prompts.ts because the workhorse bulk-moved everything from context.ts into wherever was convenient. The overseer should have caught that file hashing has nothing to do with prompt building.
- The workhorse will always take the path of least resistance: move code, wire deps, make tests pass. That satisfies "tests green" but not "deep modules." The overseer must reject mechanical extractions that pass tests but violate the design intent.

**Rule for future steps:** The overseer must verify interface surface, not just test results. If a new module's dependency interface has more than ~5 members, that's a red flag. If a function lands in a module where it doesn't conceptually belong, that's a reject — even if tests pass.

## ✅ Fixed: 1. engine.ts god file → extracted manual.ts
## ✅ Fixed: 2. context.ts absorbed into engine.ts
## ✅ Fixed: 3. verdicts.ts shrunk to 3 constants
## ✅ Fixed: 4. types.ts single-consumer types moved
## ✅ Fixed: 5. Missing test behaviors added
## ✅ Fixed: 6. seedDemoRounds extracted to demo.ts

## ✅ Fixed: 7. ManualDeps has 20 methods — fat interface defeats deep module purpose

Resolved by Phase 2: engine.ts was deleted entirely. Each mode now owns its loop top-to-bottom and talks to session.ts (a narrow infrastructure module), not to a ManualDeps umbilical cord. Original analysis below for reference.

manual.ts was extracted from engine.ts. Good. But the seam is wrong.

`ManualDeps` — the interface manual.ts uses to talk to engine.ts — has 20 methods:

```typescript
interface ManualDeps {
    pi: ExtensionAPI;
    getState(): LoopState;
    setState(s: LoopState): void;
    getLoopCommandCtx(): any;
    setLoopCommandCtx(ctx: any): void;
    setStatusPrefix(prefix: string): void;
    getSavedEditorEnv(): Record<string, string | undefined>;
    stopLoop(ctx: any): Promise<void>;
    navigateToAnchor(ctx: any): Promise<boolean>;
    startWorkhorse(text: string, ctx: any): Promise<void>;
    updateStatus(ctx: any): void;
    startStatusTimer(ctx: any): void;
    rememberAnchor(ctx: any): void;
    blockInteractiveEditors(): void;
    log(text: string): void;
    pauseTimer(): void;
    resumeTimer(): void;
    modelToStr(model: any): string;
    setModeHooks(hooks: ModeHooks): void;
}
```

This is not a deep module. This is a shallow extraction with a fat umbilical cord back to engine.ts. The interface surface is nearly as complex as the implementation it wraps (348 lines). The whole point: simple interface, complex implementation. ManualDeps is the opposite.

What happened: manual mode was ripped out mechanically. Every internal function it touched became a dep. Nobody asked "what's the minimal interface manual.ts actually needs?"

**Fix:** Collapse ManualDeps into 3-4 high-level operations that hide engine internals:

```typescript
interface ManualDeps {
    pi: ExtensionAPI;
    engine: {
        state: LoopState;
        prepareLoop(opts: ManualLoopInit, ctx: any): void; // setState + setLoopCommandCtx + rememberAnchor + blockEditors + startTimer
        stopLoop(ctx: any): Promise<void>;
        startWorkhorse(text: string, ctx: any): Promise<void>;
        log(text: string): void;
    };
}
```

`prepareLoop` absorbs the 10+ setup calls manual.ts makes into one call. Engine owns the setup sequence — manual.ts just says what it wants. `modelToStr`, `pauseTimer`, `resumeTimer`, `setStatusPrefix`, `updateStatus`, `getSavedEditorEnv`, `navigateToAnchor` — all engine internals that manual.ts shouldn't know about.

This may require manual.ts to delegate more back to engine. That's fine. The module boundary should be: manual.ts owns commit selection, editor review, and plannotator integration. Engine owns loop lifecycle, timing, status, model switching. If manual.ts needs to pause a timer, that's engine's job through a higher-level call (e.g. `engine.enterFeedbackPhase()`).

## ✅ Fixed: 8. snapshotContextHashes and changedContextPaths live in prompts.ts

Resolved by Phase 2: prompts.ts was deleted. Each mode absorbed its own prompt builders. Context hashing lives in context.ts (snapshotContextHashes, findChangedContextPaths) where it belongs. Original analysis below for reference.

These are context file hashing functions. They detect when @path files change between rounds. They have nothing to do with prompt building.

They're in prompts.ts because context.ts was being absorbed and expandContextPaths went to prompts.ts, so the rest followed. Lazy placement.

Only consumer: engine.ts.
