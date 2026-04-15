# Deep Modules Plan

This plan restructures the loop extension's internals for deep modules. It is meant to be executed via `/loop:exec` on a clean-slate agent. Everything the agent needs is in this file.

## Run tests

```bash
npx tsx --test tests/*.test.ts
```

All tests must pass after every step. No exceptions.

## Codebase map

```
index.ts          (1040 lines) — GOD FILE. State machine + commands + all logic.
types.ts          (118 lines)  — Types and LoopState. Shared across modules.
config.ts         (64 lines)   — loadConfig, saveConfigField. Reads ~/.pi/agent/settings.json.
context.ts        (102 lines)  — parseArgs, expandContextPaths, snapshotContextHashes, changedContextPaths.
session.ts        (39 lines)   — sanitize, modelToStr, findModel, getLastAssistant, extractText.
verdicts.ts       (31 lines)   — V_APPROVED, V_CHANGES, V_FIXES_COMPLETE, matchVerdict, hasFixesComplete, stripVerdict.
prompts.ts        (19 lines)   — Router: promptSets record mapping LoopMode → PromptSet.
prompts-review.ts (154 lines)  — Review mode prompts (overseer + workhorse).
prompts-exec.ts   (118 lines)  — Exec mode prompts (orchestrator + implementer).
prompts-manual.ts (115 lines)  — Manual mode prompts (verify + fix).
reconstruct.ts    (76 lines)   — reconstructState: recovers loop state from session entries.
log-view.ts       (548 lines)  — showLog: TUI log viewer with search, navigation, timing.
fixup-audit.ts    (131 lines)  — extractTaggedSHAs, snapshotPatchIds, detectUnchanged, resolveSubjects, findSnapshotBase.
git-manual.ts     (189 lines)  — resolveRange, getCommitList, getCommitDiff, buildPatchIdMap, remapAfterRebase, checkGitState, fixGitState, gitToplevel.
diff-review.ts    (159 lines)  — reviewCommitInEditor, parseAnnotations.
tui-runtime.ts    (48 lines)   — loadPiAgent, loadTui. Finds pi's install path for TUI deps.
```

## Test classification

### Integration tests (test through extension API — KEEP)

These import `index.ts` and test through `/loop` commands + `agent_end` events. They survive any internal restructure.

- `context-isolation.test.ts` (220 lines) — Fresh mode resets context per round.
- `exec-mode.test.ts` (188 lines) — `/loop:exec` orchestrator/workhorse prompts and flow.
- `ghost-after-done.test.ts` (109 lines) — No ghost messages after loop stops.
- `log-view.test.ts` (1038 lines) — TUI log viewer navigation, search, timing.
- `manual-mode.test.ts` (354 lines) — `/loop:manual` review flow, inner loop, commit selection.
- `model-auth.test.ts` (99 lines) — Model auth failure stops loop cleanly.
- `workhorse-capture.test.ts` (141 lines) — Workhorse output captured at agent_end time.

### Unit tests (import internal functions — CONVERT)

These import internal functions directly. They break on any rename, move, or restructure.

- `prompts.test.ts` (161 lines) — Imports `promptSets` from `prompts.ts`. Asserts prompt strings contain expected text.
- `prompts-manual.test.ts` (113 lines) — Same, for manual mode prompts.
- `rewrite-history.test.ts` (37 lines) — Same, for rewriteHistory flag in workhorse prompts.
- `context-changed.test.ts` (177 lines) — Imports `snapshotContextHashes`, `changedContextPaths` from `context.ts`. Tests file hashing and diff detection on temp files.
- `diff-review.test.ts` (81 lines) — Imports `parseAnnotations` from `diff-review.ts`. Tests annotation parsing from diff strings.
- `fixup-audit.test.ts` (245 lines) — Imports `extractTaggedSHAs`, `snapshotPatchIds`, `detectUnchanged` from `fixup-audit.ts`. Tests SHA extraction and patch-id fingerprinting in temp git repos.
- `git-manual.test.ts` (280 lines) — Imports `resolveRange`, `getCommitList`, `buildPatchIdMap`, `remapAfterRebase`, `checkGitState`, `fixGitState` from `git-manual.ts`. Tests git utilities in temp repos.

## Testing API (harness pattern)

All integration tests use a harness that mocks pi's extension API. Here is the canonical pattern. A new agent MUST use this pattern — not invent a new one.

```typescript
import assert from "node:assert/strict";
import test from "node:test";
import loopExtension from "../index.ts";
import { V_APPROVED, V_CHANGES, V_FIXES_COMPLETE } from "../verdicts.ts";

function wait(ms = 150): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function createHarness(cwdOverride?: string) {
  const commands = new Map<string, (args: string, ctx: any) => Promise<void> | void>();
  const events = new Map<string, (event: any, ctx: any) => void>();
  const userMessages: string[] = [];
  const logMessages: string[] = [];
  const notifications: Array<{ message: string; level: string }> = [];
  const entries: any[] = [{ id: "root", type: "message", message: { role: "user", content: "root" } }];
  let thinking = "low";
  let leafId = "root";
  let seq = 0;

  // Event bus for loop:set-review-fn and plannotator
  const eventHandlers = new Map<string, Function[]>();
  let reviewResults: Array<{ approved: boolean; feedback: string }> = [];

  const pi: any = {
    registerCommand(name: string, spec: { handler: (args: string, ctx: any) => Promise<void> | void }) {
      commands.set(name, spec.handler);
    },
    on(name: string, handler: (event: any, ctx: any) => void) {
      events.set(name, handler);
    },
    events: {
      emit(channel: string, data: unknown) {
        const handlers = eventHandlers.get(channel) || [];
        for (const h of handlers) h(data);
      },
      on(channel: string, handler: Function) {
        if (!eventHandlers.has(channel)) eventHandlers.set(channel, []);
        eventHandlers.get(channel)!.push(handler);
        return () => {
          const arr = eventHandlers.get(channel);
          if (arr) eventHandlers.set(channel, arr.filter(h => h !== handler));
        };
      },
    },
    sendMessage(message: any, options?: any) {
      if (message.customType === "loop-log") logMessages.push(String(message.content));
    },
    sendUserMessage(content: string) {
      userMessages.push(String(content));
    },
    appendEntry(_customType: string, _data: any) {
      seq++;
      leafId = `custom-${seq}`;
      entries.push({ id: leafId, type: "custom", customType: _customType, data: _data });
    },
    async setModel(model: any) {
      ctx.model = model;
      return true;
    },
    setThinkingLevel(level: string) { thinking = level; },
    getThinkingLevel() { return thinking; },
    registerMessageRenderer() {},
  };

  const ctx: any = {
    cwd: cwdOverride || process.cwd(),
    hasUI: true,
    model: { provider: "openai", id: "gpt-4.1-mini" },
    modelRegistry: { find(provider: string, id: string) { return { provider, id }; } },
    waitForIdle: async () => {},
    navigateTree: async (id: string) => { leafId = id; return { cancelled: false }; },
    sessionManager: {
      getEntries: () => entries,
      getBranch: () => entries,
      getLeafId: () => leafId,
    },
    ui: {
      notify(msg: string, level: string) { notifications.push({ message: msg, level }); },
      setStatus() {},
      select: async () => undefined,
      input: async () => undefined,
      custom: async () => undefined,
      theme: { fg: (_c: string, t: string) => t, bg: (_c: string, t: string) => t, bold: (t: string) => t },
    },
  };

  loopExtension(pi as any);

  // Inject mock review function for manual mode
  pi.events.emit("loop:set-review-fn", () => {
    if (reviewResults.length > 0) return reviewResults.shift()!;
    return { approved: true, feedback: "" };
  });

  function pushAssistant(text: string): void {
    seq++;
    const id = `assistant-${seq}`;
    entries.push({
      id,
      type: "message",
      message: { role: "assistant", content: text, stopReason: "end_turn" },
    });
    leafId = id;
  }

  async function fireAgentEnd(): Promise<void> {
    const handler = events.get("agent_end");
    assert.ok(handler);
    handler({}, ctx);
    await wait();
  }

  async function stopLoop(): Promise<void> {
    const stop = commands.get("loop:stop");
    if (stop) await stop("", ctx);
  }

  return {
    commands, events, ctx, pi, userMessages, logMessages, notifications,
    reviewResults, pushAssistant, fireAgentEnd, stopLoop,
  };
}
```

### Key patterns

**Starting a loop and checking the first prompt:**
```typescript
const h = createHarness();
await h.commands.get("loop")!("check auth", h.ctx);
assert.equal(h.userMessages.length, 1);
assert.match(h.userMessages[0], /code overseer/i);
await h.stopLoop();
```

**Simulating overseer → workhorse → overseer flow:**
```typescript
const h = createHarness();
await h.commands.get("loop")!("check auth", h.ctx);
// Overseer says CHANGES_REQUESTED
h.pushAssistant(`Found issues.\n\n${V_CHANGES}`);
await h.fireAgentEnd();
// Now h.userMessages[1] contains the workhorse prompt
h.pushAssistant(`Fixed everything.\n\n${V_FIXES_COMPLETE}`);
await h.fireAgentEnd();
// Now h.userMessages[2] contains the round 2 overseer prompt
await h.stopLoop();
```

**Manual mode with review feedback:**
```typescript
const h = createHarness(repoCwd);
h.reviewResults.push({ approved: false, feedback: "fix error handling" });
await h.commands.get("loop:manual")!(sha, h.ctx);
// h.userMessages[0] is the workhorse prompt with the feedback
```

**Checking loop log output:**
```typescript
const hasLog = h.logMessages.some(m => m.includes("Changed @paths"));
```

**Modifying config for a test:**
```typescript
const { loadConfig, saveConfigField } = await import("../config.ts");
const saved = loadConfig(process.cwd()).reviewMode;
saveConfigField("reviewMode", "incremental");
try {
  // ... test ...
} finally {
  saveConfigField("reviewMode", saved);
}
```

## Principles

1. **Moving files into directories doesn't make deep modules.** A type is also a module. Depth comes from the ratio of implementation complexity to interface surface — not from filesystem nesting. A 31-line file in a `verdicts/` folder is still shallow.

2. **Deep modules = lots of implementation behind a simple interface.** Like Unix file I/O: 5 functions, thousands of lines behind it.

3. **Tests must test behavior through the public API, not internal structure.** Unit tests that import internal functions couple to implementation. They break on refactors. Integration tests through the extension API survive any internal restructure.

4. **Every test file imports ONLY `index.ts` and `verdicts.ts`.** No other internal imports. If a test needs verdicts constants, import from `verdicts.ts` (that's protocol, not implementation). Everything else goes through the harness.

5. **Preserve all existing test behaviors.** Do not lose coverage. Every assertion in the old unit tests must have a corresponding assertion in the new integration tests.

## Steps

Each step is one atomic task for the workhorse. The overseer verifies tests pass and the behavior is preserved before moving to the next step.

### Step 1: Convert prompts unit tests to integration tests

**Delete:** `tests/prompts.test.ts`, `tests/prompts-manual.test.ts`, `tests/rewrite-history.test.ts`

**Create:** `tests/prompts-integration.test.ts`

These three files test prompt string contents by importing `promptSets` directly. Convert each assertion to test through the harness by starting a loop and checking `userMessages`.

**Behaviors to preserve (from `prompts.test.ts`):**
- `/loop:exec` first prompt contains: "orchestrator" role, focus text, "one step" drip-feed instruction, V_APPROVED/V_CHANGES markers, "do not modify/edit/write" rule
- `/loop:exec` round 2 prompt includes previous workhorse summary text
- Exec workhorse prompt contains: orchestrator instructions, V_FIXES_COMPLETE, git commit instruction, "ONLY single step", "not subagent"
- `/loop` first prompt contains: "code overseer" role, focus text, V_APPROVED/V_CHANGES
- Incremental review round 2 with `unchangedCommits` includes commit names and "red flag" warning
- Incremental review round 2 without unchanged commits has no warning
- Incremental review round 2 with `changedContextPaths` includes "Updated context files" and file contents
- Incremental review round 2 without changed paths has no context section
- Fresh review round 2 does NOT include unchanged commits warning
- Review workhorse prompt contains: "Overseer Feedback" heading, overseer text, V_FIXES_COMPLETE

**Behaviors to preserve (from `prompts-manual.test.ts`):**
- Manual overseer prompt mentions "verify" and includes user feedback text
- Manual overseer prompt includes commit SHA
- Manual overseer prompt does NOT mention "code overseer" or "orchestrator"
- Manual overseer prompt says not to add own issues
- Manual overseer round 2 is a shorter "re-verify" prompt, still includes SHA and feedback
- Manual overseer falls back to focus text when userFeedback is undefined
- Manual workhorse prompt includes V_FIXES_COMPLETE
- Manual workhorse prompt includes `--fixup=<sha>`, `--amend`, `git show <sha>`
- Manual workhorse prompt strips VERDICT from input
- Manual workhorse without COMMIT prefix uses "referenced in the feedback above"

**Behaviors to preserve (from `rewrite-history.test.ts`):**
- Review workhorse prompt WITHOUT `rewriteHistory` does not contain `--fixup`, `--amend`, `autosquash`
- Review workhorse prompt WITH `rewriteHistory: true` contains `--fixup`, `--amend`, `autosquash`
- Both cases include V_FIXES_COMPLETE

**How to test through the harness:**

For `/loop` and `/loop:exec` prompts: start the loop, check `h.userMessages[0]`. Simulate a round (overseer CHANGES_REQUESTED → workhorse FIXES_COMPLETE) and check subsequent prompts.

For manual mode: use `createHarness(repoCwd)`, push review feedback, check the workhorse and overseer prompts in `h.userMessages`.

For incremental review with unchanged commits and changed context paths: these require the extension to detect them during the loop. The simplest approach: start an incremental loop, simulate overseer text that references commit SHAs (so `extractTaggedSHAs` finds them), simulate workhorse completion without actually changing the commits (so `detectUnchanged` flags them). Check the round 2 overseer prompt in `h.userMessages`. Same for changed @paths — create real temp files as @path args, modify them between phases.

For `rewriteHistory`: set `saveConfigField("rewriteHistory", true)` before starting the loop, check the workhorse prompt.

NOTE: Some prompts.test.ts tests are already covered by exec-mode.test.ts. Don't duplicate them. Only add tests for behaviors NOT already covered by existing integration tests. Check what exec-mode.test.ts already covers before writing.

**Acceptance criteria:**
- `prompts.test.ts`, `prompts-manual.test.ts`, `rewrite-history.test.ts` deleted
- `prompts-integration.test.ts` exists and passes
- Every behavior listed above has a corresponding assertion in either the new file or an existing integration test
- `npx tsx --test tests/*.test.ts` passes

### Step 2: Convert diff-review unit tests to integration tests

**Delete:** `tests/diff-review.test.ts`

**Add to:** `tests/manual-mode.test.ts` (these behaviors are part of manual mode)

The unit tests check `parseAnnotations` — the algorithm that extracts user comments from an edited diff. In integration, this is tested through the manual mode flow: inject review feedback via `loop:set-review-fn`, check that the workhorse prompt contains the expected `file:line` references.

**Behaviors to preserve:**
- No comments in edited diff = approve (no workhorse prompt sent)
- Single line comment below a `+` line produces feedback with correct file and line number
- Range annotation (empty line separator) produces feedback spanning the range
- Multiple comments on different files produce separate feedback entries for each file

**How to test:**

The manual mode harness already injects review results via `reviewResults.push()`. The review function mock returns `{ approved, feedback }`. In production, `reviewCommitInEditor` calls `parseAnnotations` internally and formats the feedback string as `sha:file:line — comment`.

To test the integration: set up a temp repo, add a commit, invoke `/loop:manual <sha>`, inject feedback strings matching the format `parseAnnotations` would produce. Verify the workhorse prompt in `h.userMessages[0]` contains the expected `file:line` references and comment text.

For the "no comments = approve" case: the default mock returns `{ approved: true, feedback: "" }`, which already covers this (no workhorse prompt sent = loop ends).

**Acceptance criteria:**
- `diff-review.test.ts` deleted
- New tests in `manual-mode.test.ts` cover the behaviors above
- `npx tsx --test tests/*.test.ts` passes

### Step 3: Convert context-changed unit tests to integration tests

**Delete:** `tests/context-changed.test.ts`

**Create:** `tests/context-paths.test.ts`

These tests check that the extension detects when @path files change during the workhorse phase and reports them in the overseer re-review prompt.

**Behaviors to preserve:**
- Hashing produces consistent results for same content
- Hashing produces different results for changed content
- Directory @paths hash all files inside (recursively)
- When a directory's child file changes, the directory hash changes
- Missing paths are skipped silently
- Only modified files are reported as changed
- Unchanged files are not reported
- New files (added after snapshot) count as changed

**How to test through the harness:**

Create real temp files as @path args. Start an incremental review loop (`saveConfigField("reviewMode", "incremental")`). After the overseer sends CHANGES_REQUESTED:
1. Modify some @path files on disk (between overseer end and workhorse completion)
2. Simulate workhorse completion (FIXES_COMPLETE)
3. Check the round 2 overseer prompt in `h.userMessages` for "Updated context files" and the changed file contents

The extension snapshots context hashes before the workhorse runs (in `startWorkhorse`), then compares after (`onWorkhorseDone`). It logs `📄 Changed @paths:` and passes `changedContextPaths` to the overseer prompt.

Important: the context hashes are snapshotted when `startWorkhorse` is called (which happens after the overseer's CHANGES_REQUESTED fires agent_end). Modify files AFTER `fireAgentEnd()` for the overseer but BEFORE `fireAgentEnd()` for the workhorse.

Actually, the snapshot happens in `startWorkhorse` which runs as part of the `continueLoop` deferred callback after the overseer's agent_end. The files need to be modified after the workhorse starts but before its agent_end. Since the harness is synchronous for file operations, modify files after the overseer's `fireAgentEnd()` and before pushing the workhorse's assistant text.

**Acceptance criteria:**
- `context-changed.test.ts` deleted
- `context-paths.test.ts` exists and passes
- All 8 behaviors above are covered
- `npx tsx --test tests/*.test.ts` passes

### Step 4: Convert fixup-audit unit tests to integration tests

**Delete:** `tests/fixup-audit.test.ts`

**Add to:** `tests/prompts-integration.test.ts` (for extractTaggedSHAs — it affects prompt content) and create or extend tests that check the `⚠️ Unchanged commits:` log output.

**Behaviors to preserve:**

*extractTaggedSHAs:*
- Extracts SHAs near "commit" keyword in backticks
- Extracts SHAs from git log style output (SHA at line start)
- Extracts SHAs from `--fixup=<sha>` references
- Deduplicates SHAs
- Returns empty for text without SHAs
- Ignores short hex strings under 7 chars

*snapshotPatchIds + detectUnchanged:*
- Honest workhorse (separate fixup per commit) → all commits change patch-id → no unchanged warning
- Cheating workhorse (lumps all fixes into one commit) → untouched commits detected as unchanged
- Partial fix (only tagged commits checked) → untagged commits not checked
- Single tagged commit → detectUnchanged still works

**How to test through the harness:**

The extension uses `extractTaggedSHAs` internally to find commit references in overseer text, then `snapshotPatchIds` + `detectUnchanged` to compare before/after. The result appears as:
1. Log message: `⚠️ Unchanged commits: <subjects>`
2. Round 2 overseer prompt: "## ⚠️ Unchanged commits detected" section

For integration testing:
- Set up a real temp git repo with multiple commits
- Start an incremental review loop
- Make the overseer text reference specific commit SHAs (in backtick format, e.g., `` `abc1234` ``)
- Between the overseer and workhorse completion, use `execSync` to actually modify (or not modify) the repo commits
- Check `h.logMessages` for unchanged commit warnings
- Check the round 2 overseer prompt for the warning section

This is complex because it requires the harness to work with real git repos. The existing `manual-mode.test.ts` already does this (creates temp repos, adds commits, runs manual mode). Follow that pattern.

For extractTaggedSHAs specifically — it's tested indirectly. If the overseer text contains `` `abc1234` `` and the extension correctly snapshots and compares those commits, the extraction worked. Test the end-to-end: overseer mentions SHAs → workhorse doesn't fix them → log shows unchanged warning.

**Acceptance criteria:**
- `fixup-audit.test.ts` deleted
- New tests cover the unchanged commit detection flow through the harness
- `npx tsx --test tests/*.test.ts` passes

### Step 5: Convert git-manual unit tests to integration tests

**Delete:** `tests/git-manual.test.ts`

**Add to:** `tests/manual-mode.test.ts`

**Behaviors to preserve:**

*resolveRange:*
- Explicit range returned as-is
- Feature branch detects merge-base from main
- On main with commits uses root as base

*getCommitList:*
- Returns SHAs in chronological order
- Returns empty for empty range

*getCommitDiff:*
- Returns diff content with filename and file content

*buildPatchIdMap:*
- Maps patch-ids to SHAs for commits in range

*remapAfterRebase:*
- Tracks SHA changes after amend (old SHA remapped to new)
- Detects lost commits after squash

*checkGitState / fixGitState:*
- Clean repo returns null
- Detects dirty tree
- Detects in-progress rebase, fixGitState aborts it

**How to test through the harness:**

These utilities are used by manual mode. Test through `/loop:manual`:
- **resolveRange**: Start `/loop:manual` with no args on a feature branch. The picker should show commits since merge-base. On main, it should show commits since root.
- **getCommitList**: Start manual mode, verify the picker shows the correct number of commits in order.
- **buildPatchIdMap / remapAfterRebase**: Start manual mode, inject feedback, have the workhorse amend/rebase. The extension calls `remapAfterRebase` internally to track commit changes. Verify the loop correctly follows the commit through the rebase.
- **checkGitState / fixGitState**: Start manual mode on a repo with a dirty tree or in-progress rebase. Verify the extension handles it (notifies user, aborts rebase, etc.).

Note: Some of these (like resolveRange returning explicit range as-is) are trivially covered. The commit picker test covers getCommitList. The "fix dirty git state" is already partially tested by manual-mode.test.ts flow.

**Acceptance criteria:**
- `git-manual.test.ts` deleted
- New tests in `manual-mode.test.ts` cover the behaviors above
- `npx tsx --test tests/*.test.ts` passes

### Step 6: Verify all unit test files are deleted

At this point, the following files should be gone:
- `tests/prompts.test.ts`
- `tests/prompts-manual.test.ts`
- `tests/rewrite-history.test.ts`
- `tests/context-changed.test.ts`
- `tests/diff-review.test.ts`
- `tests/fixup-audit.test.ts`
- `tests/git-manual.test.ts`

Run `npx tsx --test tests/*.test.ts` — all remaining tests pass.

Run `grep -r "from \"\.\.\/" tests/` and verify that no test file imports from anything other than `../index.ts` and `../verdicts.ts` .

`log-view.test.ts` currently imports `loadPiAgent` from `../log-view.ts` and `showLog` via dynamic import. This couples tests to log-view internals. Convert these to go through the harness via `/loop:log`, or at minimum expose what's needed through index.ts.

**Gate:** `grep -r "from \"\.\.\/" tests/ | grep -v index.ts | grep -v verdicts.ts` must return NOTHING.

**STOP HERE.** Phase 1 is complete. Do not proceed to Phase 2 in the same session. Phase 2 is a separate `/loop:exec` run.

---


## Phase 2: Each mode owns its loop, top to bottom

**Prerequisite:** Phase 1 is complete. All tests are integration tests.

### The architecture

Each mode is a straight-line `while` loop. No event routing. No callbacks. No state machine phases. The mode calls session, session sends a prompt, awaits the response, returns it. The mode reads the response and decides what to do next. Top to bottom.

```
/loop ──→ review-fresh / review-incremental
/loop:exec ──→ exec
/loop:manual ──→ manual

Each mode calls:
  session.setModel(modelStr, thinking, ctx) → Promise<boolean>
  session.send(prompt) → Promise<{ text: string }>
  session.navigateToAnchor(ctx)
  session.navigateToEntry(id, ctx)
  ...etc

Session wraps pi's async event model in a synchronous-looking API.
Modes never see agent_end events. They just await.
```

### What a mode looks like

```typescript
// review-fresh.ts — the entire loop
async function loop(session, ctx) {
  const cfg = loadConfig(ctx.cwd);
  const { focus, contextPaths } = context.parseArgs(args, ctx.cwd);
  session.rememberAnchor(ctx);
  session.blockEditors();
  status.start();

  try {
    let round = 1;
    while (round <= cfg.maxRounds) {
      // Overseer turn — mode picks model, builds prompt, reads response
      await session.navigateToAnchor(ctx);
      await session.setModel(cfg.overseerModel, cfg.overseerThinking, ctx);
      const { text: review } = await session.send(buildOverseerPrompt(focus, round, contextPaths));
      const v = verdict.matchVerdict(review);
      if (v === "approved") { ctx.ui.notify("✅ Approved"); break; }
      if (v !== "changes_requested") {
        await session.send("Continue. End with " + V_APPROVED + " or " + V_CHANGES);
        continue;
      }

      // Workhorse turn — mode picks different model, different prompt
      await session.navigateToAnchor(ctx);
      await session.setModel(cfg.workhorseModel, cfg.workhorseThinking, ctx);
      let { text: fix } = await session.send(buildWorkhorsePrompt(review, round));
      while (!verdict.hasFixesComplete(fix)) {
        ({ text: fix } = await session.send("Continue. End with " + V_FIXES_COMPLETE));
      }

      ctx.ui.setStatus("loop", `Round ${round} · ${status.formatDuration(status.elapsed())}`);
      round++;
    }
  } catch (e) {
    if (e instanceof StopError) { /* /loop:stop called */ }
    else throw e;
  }

  status.stop();
  session.restoreEditors();
}
```

No callbacks. No event dispatch. No state machine. Just a `while` loop with `await`. The mode decides everything: when to navigate, what prompt to send, how to interpret the response, when to stop.

### How session wraps pi's async events

Pi is event-driven (`agent_end` fires when the model finishes). Session wraps this in a promise:

```typescript
// session.ts internals
let pendingResolve: ((text: string) => void) | null = null;

pi.on("agent_end", (_event, ctx) => {
  if (!pendingResolve) return;
  const { text, stopReason } = getLastAssistant(ctx);
  if (stopReason === "abort" || stopReason === "cancelled") return;
  const resolve = pendingResolve;
  pendingResolve = null;
  resolve(text);
});

async function setModel(modelStr: string, thinking: string, ctx: any): Promise<boolean> {
  const model = findModel(modelStr, ctx);
  if (!model) return false;
  if (!await pi.setModel(model)) return false;
  pi.setThinkingLevel(thinking as any);
  return true;
}

async function send(prompt: string): Promise<{ text: string }> {
  return new Promise((resolve, reject) => {
    pendingResolve = resolve;
    pendingReject = reject;
    pi.sendUserMessage(prompt);
  });
}

function stop(): void {
  if (pendingReject) {
    pendingReject(new StopError());
    pendingResolve = null;
    pendingReject = null;
  }
}
```

Session hides pi's event model. Modes see: "send prompt, get response." That's it.

### Module hierarchy

```
Modes (own the loop, decide everything)
  review-fresh        — while loop: overseer → workhorse → repeat
  review-incremental  — while loop: overseer → workhorse → repeat (+ patch-id audit, context tracking)
  exec                — while loop: orchestrator → workhorse → repeat (+ task extraction)
  manual              — commit loop: user reviews → workhorse fixes → overseer verifies

Infrastructure (toolkit, called by modes)
  session             — setModel, send, navigate, anchor, blockEditors
  verdict             — matchVerdict, hasFixesComplete, stripVerdict, sanitize, constants
  context             — parseArgs, readPaths (raw), snapshotContextHashes
  status              — start, stop, update, pause, resume, formatDuration
  git                 — resolveRange, checkGitState, snapshotBeforeWorkhorse
  config              — loadConfig, saveConfigField
  diff-review         — reviewCommitInEditor (used by manual)
  review-workhorse    — shared fix prompt (used by both review modes)

Orchestrator
  index               — creates session + status, creates modes, registers commands
```

Dependencies flow downward only. No mode knows about another mode. Infrastructure doesn't know modes exist. Index creates everything and routes commands to the right mode.

### session.ts interface

```typescript
export interface Session {
  setModel(modelStr: string, thinking: string, ctx: any): Promise<boolean>;
  send(prompt: string): Promise<{ text: string }>;
  navigateToAnchor(ctx: any): Promise<boolean>;
  navigateToEntry(id: string, ctx: any): Promise<boolean>;
  findAnchor(ctx: any): { id: string; data: any } | null;
  rememberAnchor(ctx: any, extras?: Record<string, any>): void;
  getLeafId(ctx: any): string;
  blockEditors(): void;
  restoreEditors(): void;
  log(text: string): void;
  stop(): void;
  getBranch(ctx: any): any[];
}
export function createSession(pi: ExtensionAPI): Session;
```

Session knows nothing about overseer/workhorse/orchestrator. It switches models and sends prompts. The MODE decides which model to use for each turn:

```typescript
// Mode controls everything:
const cfg = loadConfig(ctx.cwd);
await session.setModel(cfg.overseerModel, cfg.overseerThinking, ctx);
const { text: review } = await session.send(overseerPrompt);

await session.setModel(cfg.workhorseModel, cfg.workhorseThinking, ctx);
const { text: fix } = await session.send(workhorsePrompt);
```

**~160 lines.** Session tree navigation, anchor management, editor blocking, async→promise bridging. Zero mode knowledge.

### What this kills

- **`agent_end` event routing** → gone. Session resolves a promise internally. Modes just `await`.
- **`onAgentEnd` dispatch** → gone. No active mode tracking needed in index.ts.
- **`deferIf` hacks** → gone. Straight-line async/await.
- **State machine phases** (`idle`, `reviewing`, `fixing`) → gone. The mode's position in the `while` loop IS the phase.
- **`handleOverseerEnd`/`handleWorkhorseEnd`** → gone. Mode reads response and decides inline.

### Duplication audit

| Piece | Owner | Who imports it |
|---|---|---|
| `matchVerdict`, `sanitize`, etc. | verdict.ts | all modes |
| `expandContextPaths`, `parseArgs` | context.ts | review-fresh, review-incremental, exec |
| `snapshotContextHashes` | context.ts | review-incremental |
| `setModel`, `send`, `navigateToAnchor`, etc. | session.ts | all modes |
| `formatDuration`, `totalElapsed` | status.ts | all modes |
| Git operations | git.ts | review-incremental, manual |
| `reviewCommitInEditor` | diff-review.ts | manual |
| Review fix prompt | review-workhorse.ts | review-fresh, review-incremental |
| Loop while-body (~40 lines) | each mode | nobody — each has its own |

### Change isolation

| Change | Touches only |
|---|---|
| Change fresh review prompt | `review-fresh.ts` |
| Change incremental re-review prompt | `review-incremental.ts` |
| Change review workhorse fix prompt | `review-workhorse.ts` |
| Change @path file reading / MAX_FILE_SIZE | `context.ts` |
| Change exec to support multi-step tasks | `exec.ts` |
| Add "skip commit" to manual review | `manual.ts` |
| Accept `VERDICT: ✓ APPROVED` format | `verdict.ts` |
| Change session navigation logic | `session.ts` |
| Change status bar format | the mode that owns that status text |
| Switch patch-id to tree-hash | `git.ts` |
| Change TUI log viewer | `log-view.ts` |
| Add a new config field | `config.ts` |
| Add a 4th mode | new `audit.ts` + `index.ts` |
| Add a 3rd review strategy | new `review-X.ts` + `index.ts` |

### Target file structure

```
index.ts              (~100 lines) — Orchestrator. Creates session + status, creates modes, registers commands.
review-fresh.ts       (~220 lines) — Fresh review loop. Full re-review each round.
review-incremental.ts (~320 lines) — Incremental review loop. Patch-id audit, context tracking.
review-workhorse.ts   (~50 lines)  — Shared review fix prompt.
exec.ts               (~220 lines) — Exec loop. Step-by-step plan execution.
manual.ts             (~350 lines) — Manual review loop. Editor, plannotator, commit flow.
session.ts            (~160 lines) — Pi session. setModel, send, navigate, anchors, editors. Zero mode knowledge.
verdict.ts            (~30 lines)  — Wire protocol. Constants, parsing, sanitize.
context.ts            (~80 lines)  — File I/O. @path parsing, raw reading, hashing. No formatting.
status.ts             (~60 lines)  — Timer + formatDuration. Modes own their status text.
git.ts                (~300 lines) — Git operations + opaque patch-id lifecycle.
log-view.ts           (~600 lines) — TUI log viewer.
config.ts             (~83 lines)  — Settings persistence.
diff-review.ts        (~159 lines) — Editor-based annotation.
types.ts              (~15 lines)  — Shared type aliases.
demo.ts               (~52 lines)  — Debug data.
```

### Steps

#### Step 7: Create session.ts

The key step. Extract pi interaction from engine.ts AND add the promise-based `setModel` + `send` that wraps `agent_end` into `await`.

1. Create `session.ts` with `createSession(pi)`.
2. Move from engine.ts: navigateToAnchor, navigateToEntry, findAnchor, rememberAnchor, findModel, modelToStr, getLastAssistant, extractText, blockEditors, restoreEditors, log.
3. Add `setModel(modelStr, thinking, ctx) → Promise<boolean>` and `send(prompt) → Promise<{ text: string }>` + `stop()` that rejects pending promise. Return an object, not a bare string — future metadata (tokens, latency) becomes additive with zero ripple.
4. Register `agent_end` inside session.ts to resolve pending promises.
5. Tests pass (engine.ts still works, imports from session.ts).

#### Step 8: Create status.ts, verdict.ts, context.ts

Extract from engine.ts and prompts.ts:
- **status.ts**: timer only — start, stop, pause, resume, elapsed(), formatDuration, formatTime. No status bar text (modes set their own via `ctx.ui.setStatus`).
- **verdict.ts**: matchVerdict, hasFixesComplete, stripVerdict, sanitize, constants, regexes. Merge CHANGES_STRIP_RE from prompts.ts.
- **context.ts**: parseArgs, readPaths (returns `{path, content}[]` — raw, no markdown), snapshotContextHashes, findChangedContextPaths. Modes format the content for their prompts.

Delete all duplicates from engine.ts. Tests pass.

#### Step 9: Create review-fresh.ts

1. Create `createFreshReview(session, status)`.
2. Move full review overseer prompt from prompts.ts.
3. Write the loop as a straight-line `while` with `await session.setModel` + `await session.send`.
4. Imports: session.ts, verdict.ts, context.ts, status.ts, config.ts, review-workhorse.ts.
5. Wire in index.ts. Tests pass for `/loop` in fresh mode.

#### Step 10: Create review-workhorse.ts

Extract from prompts.ts and engine.ts:
- Shared review workhorse fix prompt (both review modes import it).
- `reconstructState` from engine.ts — review-specific history parsing (rounds, verdicts, resume point). Session only provides raw `getBranch()`, this module interprets it.

Both review modes import review-workhorse.ts for fix prompts and state reconstruction.

#### Step 11: Create review-incremental.ts

1. Create `createIncrementalReview(session, status)`.
2. Move incremental prompt from prompts.ts.
3. Write the loop (like fresh but with: leaf navigation, summary passing, patch-id snapshot/compare).
4. Imports: session.ts, verdict.ts, context.ts, git.ts, status.ts, config.ts, review-workhorse.ts.
5. Wire in index.ts. Tests pass for `/loop` in incremental mode.

#### Step 12: Create exec.ts

1. Create `createExecMode(session, status)`.
2. Move exec prompts + extractTask from prompts.ts.
3. Write the loop.
4. Imports: session.ts, verdict.ts, context.ts, status.ts, config.ts.
5. Wire in index.ts. Tests pass for `/loop:exec`.

#### Step 13: Update manual.ts

1. Move manual prompts from prompts.ts.
2. Rewrite to use session.setModel/send instead of ModeHooks/ManualEngine.
3. Manual owns its complete flow: commit picking → editor review → workhorse fix → overseer verify.
4. Imports: session.ts, verdict.ts, git.ts, diff-review.ts, status.ts, config.ts.
5. Tests pass for `/loop:manual`.

#### Step 14: Delete engine.ts and prompts.ts

All code moved. Delete both. Tests pass.

#### Step 15: Slim index.ts

```typescript
export default function(pi) {
  const session = createSession(pi);
  const status = createStatus();

  const fresh = createFreshReview(session, status);
  const incremental = createIncrementalReview(session, status);
  const exec = createExecMode(session, status);
  const manual = createManualMode(session, status);

  pi.registerCommand("loop", {
    handler: (args, ctx) => {
      const cfg = loadConfig(ctx.cwd);
      return cfg.reviewMode === "incremental"
        ? incremental.start(args, ctx)
        : fresh.start(args, ctx);
    }
  });
  pi.registerCommand("loop:exec", { handler: (args, ctx) => exec.start(args, ctx) });
  pi.registerCommand("loop:manual", { handler: (args, ctx) => manual.start(args, ctx) });
  pi.registerCommand("loop:stop", { handler: () => session.stop() });
  // /loop:log, /loop:cfg, /loop:rounds ...
}
```

No `agent_end` routing. No active mode tracking. ~100 lines.

#### Step 16: Verify

All tests green. Manual e2e test. Each change isolation scenario confirmed.
