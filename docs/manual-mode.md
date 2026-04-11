# Manual review mode

Human-in-the-loop commit review. You are the reviewer. The overseer supervises the workhorse until your feedback is fully addressed.

## Command

`/loop:manual <range>` — e.g. `HEAD~5..HEAD`, or auto-detect from branch.

When no range is given: find the merge-base with `main` (or `master`), review all commits from there to HEAD.

## Flow

```
/loop:manual HEAD~5..HEAD

  For each commit:
  ┌────────────────────────────────────┐
  │ Plannotator opens in browser       │
  │ showing that commit's diff         │
  │                                    │
  │ You annotate lines, click          │
  │ "Request Changes" or "Approve"     │
  └──────────────┬─────────────────────┘
                 │ structured feedback
                 ▼
  ┌────────────────────────────────────┐
  │ Overseer → Workhorse inner loop    │
  │ (automatic, incremental only)      │
  └──────────────┬─────────────────────┘
                 │ fixes applied
                 ▼
  Plannotator reopens with updated diff
  You approve → next commit
```

### Two nested loops

Outer loop (you drive): commit by commit, approve or give feedback, jump to any commit.

Inner loop (automatic): overseer takes your feedback, drives workhorse, verifies it did what you asked. Always incremental — tunnel vision is the point.

## Phases

1. Init — `git log --reverse --format=%H <range>` builds `commitList`. Snapshot patch-ids. Enter `awaiting_feedback`. Open first commit for review.
2. Show current commit — open plannotator for the commit's diff. Fall back to TUI (`select` + `input`) if plannotator not installed.
3. User responds:
   - Approve (ok / continue / plannotator approve) → advance `currentCommitIdx`, show next. Last commit → end loop.
   - Feedback (annotations or text) → enter inner loop.
   - Jump (jump \<sha\> or jump 3) → set `currentCommitIdx`, show that commit.
   - Stop → `/loop:stop`.
4. Inner loop — reuses existing overseer → workhorse machinery. Overseer gets user's feedback + commit SHA + diff. Workhorse fixes. Overseer verifies. Loop until overseer approves.
5. After inner loop — re-derive patch-ids, update `commitList` with new SHAs. Re-show same commit to user. Back to step 3.
6. End — when the last commit is approved: restore original model and thinking level (same as `/loop:stop`), show summary of rounds and time.

## Overseer role: verify, not review

In review mode, the overseer finds its own issues. In manual mode, it never does. Its only job is: "did the workhorse correctly implement the user's feedback on this commit?" It takes the user's exact annotations, watches the workhorse work, and verifies the result matches the user's intent. If the workhorse missed something or did it wrong, the overseer sends it back. It does not add its own opinions.

## Workhorse git rules

Same as review mode multi-commit rules. The commit being reviewed is often not HEAD, so the workhorse must:

1. Fix the issue, stage only the relevant files.
2. `git commit --fixup=<sha>` targeting the reviewed commit.
3. `GIT_SEQUENCE_EDITOR=true git rebase -i --autosquash <parent>` to fold it in.

If the commit is HEAD, `git commit --amend --no-edit` is sufficient.

## State additions

```ts
commitList: string[];                  // SHAs in review order
currentCommitIdx: number;              // where the user is
patchIdMap: Map<string, string>;       // patch-id → SHA (tracking after rebase)
```

## Always incremental

Manual mode is always incremental. The overseer's scope is narrow: "did the workhorse do what the user asked on this commit?" Tunnel vision is desired — the overseer should stay focused on the user's exact feedback, not holistically re-review the codebase. Fresh mode would waste tokens re-reading everything when the scope is one commit + one set of annotations.

No `reviewMode` config for manual — hardcoded to incremental.

## Commit tracking after rebase

Workhorse may amend/fixup/rebase, changing SHAs. After each inner loop:

1. `git log` the range again, re-derive patch-ids.
2. Match old patch-id → new patch-id to find where each commit landed.
3. If a patch-id vanished (split/squash): notify user, let them pick.

### Why patch-id, not subject line

Subject lines change during review (typo fixes, rewording). Patch-id is a content hash of the diff itself — survives rebase, amend, SHA changes. Only changes when the actual code diff changes, which is exactly when the user needs to re-review.

```
git patch-id --stable < <(git diff-tree -p <sha>)
```

Same approach `fixup-audit.ts` already uses for detecting unchanged commits.

### Split and squash edge cases

When a commit is split into two, neither child has the parent's patch-id. When commits are squashed, the original patch-ids disappear.

In both cases: show "commit X was split/squashed — here are the new commits in the range:" and present the list via `ctx.ui.select()` so the user picks which to review next.

## Plannotator integration

### Why plannotator is the primary path, not optional

Pi's interaction model: user input goes to the model. There is no "show diff and wait for free-text response" primitive. The available pi TUI primitives are:

- `ctx.ui.select()` — modal picker, blocks until user picks an option.
- `ctx.ui.input()` — modal text input, blocks until user types. Small single-line modal — fine for "fix the error handling" but bad for detailed multi-line line-level annotations.
- `pi.sendMessage()` — display only, no input capture.

Rich code review feedback requires a browser UI. Plannotator provides exactly this. The TUI fallback works for quick approvals and short feedback but is not suitable for serious review.

### Detection

Emit `plannotator:request` event, check if response comes back as `handled`. Cache the result.

### With plannotator

Plannotator's `code-review` action supports `uncommitted | staged | last-commit | branch` diff types — not a specific SHA. We control git, so this isn't a problem. No upstream plannotator changes needed. The specific mechanism (which diff type, what git state to set up) is an implementation detail.

Await `plannotator:review-result` for structured line-level feedback.

### Without plannotator (TUI fallback)

`pi.sendMessage()` to display the diff. `ctx.ui.select()` for actions: `["Feedback", "Approve", "Jump to...", "Stop"]`. If "Feedback" → `ctx.ui.input()` for short text. If "Jump" → `ctx.ui.select()` with commit list.

Limited to short feedback. Adequate for approvals and simple fix requests only.

## New files

`prompts-manual.ts` — overseer prompt: "the user gave this feedback on commit \<sha\>, verify the workhorse addressed it." Workhorse prompt: fix instructions scoped to that commit, same git rules as review mode.

## What doesn't change

Existing `review` and `exec` modes — untouched. Log viewer — manual mode rounds show up there too. Config — reuses same overseer/workhorse model settings. Editor blocking, status timer, stop/resume machinery.
